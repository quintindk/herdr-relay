import assert from 'node:assert/strict';
import test from 'node:test';
import { globSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import babel from '@babel/core';
import { Plugin as ServerSdk } from '@opencode/plugin';
import * as TuiSdk from '@opencode/plugin/tui/plugin';
import { Rpc as SdkRpc } from '@opencode/plugin/rpc';
import { Rpc } from '@opencode/schema/rpc';
import server from '../packages/opencode-relay/server.mjs';
import { RelayRuntime } from '../packages/opencode-relay/rpc.mjs';
import { HeadlessAccess } from '../packages/opencode-relay/headless-access.mjs';
import { HumanProposals } from '../packages/opencode-relay/human-proposals.mjs';

const root = new URL('../', import.meta.url);
const json = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const sdkImport = value => typeof value === 'string' && /^@opencode\/plugin(?:\/|$)/.test(value);

test('the plugin SDK is development-only and runtime RPC uses the matching public schema package', () => {
  for (const path of ['package.json', 'packages/opencode-relay/package.json']) {
    const pkg = json(path);
    assert.equal(pkg.dependencies['@opencode/plugin'], undefined, path);
    assert.equal(pkg.devDependencies['@opencode/plugin'], '2.1.0', path);
    assert.equal(pkg.dependencies['@opencode/schema'], pkg.dependencies['@opencode/client'], path);
    assert.equal(pkg.overrides, undefined, 'Runtime dependency removal must not require forced transitive major versions');
  }
});

test('neither lockfile retains the unused SDK, provider or matching libraries as production dependencies', () => {
  const unused = new Set(['@opencode/plugin', '@opencode/ai', '@opencode/util', 'glob', 'minimatch']);
  for (const path of ['package-lock.json', 'packages/opencode-relay/package-lock.json']) {
    for (const [location, pkg] of Object.entries(json(path).packages)) {
      const name = location.split('/node_modules/').at(-1).replace(/^node_modules\//, '');
      if (unused.has(name)) assert.equal(pkg.dev, true, `${path}: ${location} must not ship in the runtime tree`);
    }
  }
});

test('all shipped JavaScript and JSX is independent of runtime SDK wrapper imports', () => {
  const modules = new Set();
  for (const pattern of json('package.json').files) {
    for (const match of globSync(pattern, { cwd: root })) {
      const base = new URL(match, root);
      const files = statSync(base).isDirectory() ? readdirSync(base, { recursive: true }).map(file => join(match, file)) : [match];
      for (const file of files) if (/\.(?:[cm]?js|[jt]sx)$/.test(file)) modules.add(file);
    }
  }
  assert.ok(modules.has('packages/opencode-relay/tui.mjs'));
  assert.ok(modules.has('scripts/native-agent-launch.mjs'));
  for (const path of modules) {
    const ast = babel.parseSync(readFileSync(new URL(path, root), 'utf8'), {
      filename: path, configFile: false, babelrc: false, sourceType: 'module', parserOpts: { plugins: ['jsx'] },
    });
    babel.traverse(ast, {
      ImportDeclaration({ node }) { assert.ok(!sdkImport(node.source.value), `${path}: runtime SDK import`); },
      ExportNamedDeclaration({ node }) { assert.ok(!sdkImport(node.source?.value), `${path}: runtime SDK re-export`); },
      ExportAllDeclaration({ node }) { assert.ok(!sdkImport(node.source.value), `${path}: runtime SDK re-export`); },
      CallExpression({ node }) {
        if (node.callee.type === 'Import' || node.callee.type === 'Identifier' && node.callee.name === 'require')
          assert.ok(!sdkImport(node.arguments[0]?.value), `${path}: dynamic runtime SDK import`);
      },
    });
  }
});

test('plain plugin descriptors and direct RPC definitions retain the pinned SDK contract and reserved-error checks', () => {
  const descriptor = Object.freeze({ ...server });
  assert.equal(descriptor.id, 'herdr.relay.server'); assert.equal(typeof descriptor.setup, 'function');
  assert.equal(ServerSdk.define(descriptor), descriptor, 'Server SDK define must remain an identity helper');
  const tui = Object.freeze({ id: 'herdr.relay.tui', setup() {} });
  assert.equal(TuiSdk.define(tui), tui, 'TUI SDK define must remain an identity helper');
  assert.equal(Rpc.define, SdkRpc.define, 'Use the actual public schema helper re-exported by the SDK, not a local replacement');
  for (const contract of [RelayRuntime, HeadlessAccess, HumanProposals]) {
    const copy = Object.freeze(structuredClone(contract));
    assert.equal(SdkRpc.define(copy), copy);
  }
  assert.throws(() => Rpc.define({ id: 'fixture', methods: { bad: { errors: { 'rpc.reserved': {} } } }, events: {} }), /reserved/);
});
