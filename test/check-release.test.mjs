import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkRelease } from '../scripts/check-release.mjs';

function input() {
  const version = '0.2.1';
  const lock = () => ({ version, packages: { '': { version } } });
  return { root: { version }, rootLock: lock(), plugin: { version }, pluginLock: lock(),
    manifest: `name = "herdr-relay"\nversion = "${version}"\n`, notesExist: true, tag: `v${version}` };
}

test('release metadata accepts aligned versions for a branch or exact version tag', () => {
  assert.deepEqual(checkRelease(input()), { version: '0.2.1', tag: 'v0.2.1' });
  assert.equal(checkRelease({ ...input(), tag: '' }).tag, null);
});

test('release metadata refuses mismatched tags, manifests, lockfiles and absent notes', () => {
  for (const update of [{ tag: 'v0.2.2' }, { manifest: 'version = "0.2.2"' }, { notesExist: false },
    { plugin: { version: '0.2.2' } }, { rootLock: { version: '0.2.2', packages: { '': { version: '0.2.2' } } } }]) {
    assert.throws(() => checkRelease({ ...input(), ...update }));
  }
});

const execute = promisify(execFile);
function evidenceFixture(t) {
  const root = mkdtempSync(join(process.env.RELAY_TEST_SCRATCH ?? '/tmp/opencode', 'release-evidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const script = workflow.match(/^ {10}node --input-type=module <<'NODE'\n([\s\S]*?)^ {10}NODE$/m)?.[1].replace(/^ {10}/gm, '');
  assert.ok(script, 'Exercise the actual publication evidence gate without running publication');
  const versions = ['2.1.0', '2.1.2', '2.2.5'];
  const report = {
    version: '0.2.5', sourceCommit: 'fixture-commit', sourceTreeClean: true, releaseVerified: true,
    auditVerified: true, vulnerabilities: { total: 0 }, interactiveProvisioningProtocol: 1,
    installerHandover: { version: '0.2.5', passed: true, candidateProcessVerified: true, candidateOnlySetupExecuted: true,
      legacyBootstrapVerified: true, immutable022LimitationVerified: true, released023SinglePass: true,
      retryIdempotent: true, conflictRefused: true, allCandidateAuditsVerified: true, candidateAuditChecks: 6,
      legacyProductionActivationAllowed: false, syntheticFutureRelease: true, userServicesTouched: false, credentialsCopied: false },
    installedTuiVerifications: versions.map(runtime => ({ runtime, passed: true, productionPackageTuiLoaded: true,
      sidebarMounted: true, scopedStatusReceived: true, runtimeCommandAndNotification: true, pluginLoadErrors: 0 })),
    installedCliBridgeVerifications: versions.map(runtime => ({ runtime, passed: true, realModelToolTurn: true,
      pluginInvokedActualCli: true, humanTaskCreated: true, existingPeerExecutionRequested: true, activeParentRequired: false })),
    installedAgentGrantVerifications: versions.map(runtime => ({ runtime, passed: true, grantIssuedByCoordinatorWithoutOwner: true,
      agentGrantRetryIdempotent: true, revocationPausedSchedule: true, readinessHadNoExternalEffects: true })),
    installedInteractiveRecoveryVerifications: versions.map(runtime => ({ runtime, passed: true, realModelToolTurn: true, scopedAgentTools: true,
      insufficientGrantQueuedApproval: true, admissionBeforeFilesystemEffects: true, linkedRepairApproved: true, originalPreparationRetained: true,
      realReceivingSessionVerified: true, existingTaskDispatchIdempotent: true, concurrentCapacityReservationVerified: true,
      ordinaryEnrolmentCannotStealReservation: true, humanGrantRevocationVerified: true, herdrPlacementFixture: true, userServicesTouched: false, credentialsCopied: false })),
    herdrPanelVerification: { passed: true, realHerdrServer: true, candidateInstallerHandover: true, stagedPackageAuditVerified: true,
      keyboardLinkedRepairRequested: true, keyboardRepairApproved: true, keyboardGrantRevocationVerified: true, originalPreparationAndTaskPreserved: true, userServicesTouched: false },
  };
  const validate = value => {
    writeFileSync(join(root, 'herdr-relay-0.2.5.tgz.verification.json'), JSON.stringify(value));
    return execute(process.execPath, ['--input-type=module', '-e', script], { cwd: root, timeout: 10000,
      env: { ...process.env, RELEASE_TAG: 'v0.2.5', SOURCE_COMMIT: 'fixture-commit' } });
  };
  return { report, validate, versions, fields: ['installedTuiVerifications', 'installedCliBridgeVerifications', 'installedAgentGrantVerifications', 'installedInteractiveRecoveryVerifications'] };
}

test('publication evidence accepts successful installed checks on all three exact OpenCode hosts', async t => {
  const { report, validate } = evidenceFixture(t);
  await validate(report);
});

test('publication evidence refuses missing hosts and a different 2.2 patch in every installed check', async t => {
  const { report, validate, versions, fields } = evidenceFixture(t);
  for (const field of fields) {
    for (const version of versions) {
      const missing = structuredClone(report);
      missing[field] = missing[field].filter(check => check.runtime !== version);
      await assert.rejects(validate(missing), /AssertionError/);
    }
    const wrongPatch = structuredClone(report);
    wrongPatch[field].find(check => check.runtime === '2.2.5').runtime = '2.2.4';
    await assert.rejects(validate(wrongPatch), /AssertionError/);
  }
});

test('publication evidence refuses a failed 2.2.5 check even when every host is present', async t => {
  const { report, validate, fields } = evidenceFixture(t);
  for (const field of fields) {
    const failed = structuredClone(report);
    failed[field].find(check => check.runtime === '2.2.5').passed = false;
    await assert.rejects(validate(failed), /AssertionError/);
  }
});

test('publication refuses missing, failed or mismatched installer-process evidence', async t => {
  const { report, validate } = evidenceFixture(t);
  const missing = structuredClone(report); delete missing.installerHandover;
  await assert.rejects(validate(missing), /AssertionError/);
  for (const update of [{ candidateProcessVerified: false }, { legacyBootstrapVerified: false }, { version: '0.2.3' },
    { allCandidateAuditsVerified: false }, { userServicesTouched: true }, { legacyProductionActivationAllowed: true }]) {
    await assert.rejects(validate({ ...report, installerHandover: { ...report.installerHandover, ...update } }), /AssertionError/);
  }
});

test('publication refuses absent or failed Herdr keyboard evidence and unsafe recovery effects', async t => {
  const { report, validate } = evidenceFixture(t);
  const missing = structuredClone(report); delete missing.herdrPanelVerification; await assert.rejects(validate(missing), /AssertionError/);
  for (const field of ['keyboardLinkedRepairRequested', 'keyboardRepairApproved', 'keyboardGrantRevocationVerified']) {
    const failed = structuredClone(report); failed.herdrPanelVerification[field] = false; await assert.rejects(validate(failed), /AssertionError/);
  }
  for (const field of ['userServicesTouched', 'credentialsCopied']) {
    const unsafe = structuredClone(report); unsafe.installedInteractiveRecoveryVerifications[0][field] = true; await assert.rejects(validate(unsafe), /AssertionError/);
  }
});
