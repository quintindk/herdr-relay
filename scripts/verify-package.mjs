import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, constants, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { promisify } from 'node:util';
import { createServer } from 'node:http';

// A local RC artifact only. This never publishes npm packages, Git tags or a
// GitHub release, and never uses the user's native services or credentials.
const root = mkdtempSync('/tmp/opencode/relay-package-check-');
const { values } = parseArgs({ options: { output: { type: 'string' }, 'skip-audit': { type: 'boolean' }, release: { type: 'boolean' } } });
let sourceCommit = null, sourceTreeClean = false;
try {
  sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  sourceTreeClean = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() === '';
} catch {}
if (values.release) {
  assert.ok(sourceCommit && sourceTreeClean, 'Release verification requires a clean committed source tree. Commit reviewed changes first.');
  assert.equal(Boolean(values['skip-audit']), false, 'Release verification cannot skip the production audit');
}
const artifactDirectory = resolve(values.output ?? join(root, 'artifacts'));
mkdirSync(artifactDirectory, { recursive: true });
const staging = join(root, 'staging'); mkdirSync(staging);
const [packed] = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', staging], { encoding: 'utf8' }));
assert.ok(!packed.files.some(f => /(^|\/)(\.env|owner\.json|node_modules|\.firecrawl|\.git)(\/|$)/.test(f.path)), 'Package contains private or development files');
for (const path of ['src/node-interactive.mjs', 'src/interactive-contract.mjs', 'scripts/install-native-backend.mjs',
  'scripts/install-native-node.mjs', 'scripts/migrate-paperclip-tasks.mjs', 'src/native-admin-cli.mjs', 'src/native-onboarding.mjs',
  'src/agent-messages.mjs', 'src/node-messages.mjs', 'src/native-headless.mjs', 'src/skill-install.mjs',
  'skills/herdr-relay/SKILL.md', 'skills/relay-work/SKILL.md', 'docs/legacy-paperclip-work-skill.md',
  'src/headless-setup-contract.mjs', 'src/node-headless-setup.mjs', 'src/headless-setup-wait.mjs', 'packages/opencode-relay/headless-access.mjs',
  'src/service-upgrade.mjs', 'src/release-install.mjs', 'src/upgrade-cli.mjs',
  'packages/opencode-relay/server.mjs', 'packages/opencode-relay/tui.mjs']) assert.ok(packed.files.some(f => f.path === path), `Missing runtime file: ${path}`);
const artifact = join(artifactDirectory, packed.filename), consumer = join(root, 'consumer');
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
if (existsSync(artifact)) assert.equal(sha(artifact), sha(join(staging, packed.filename)), 'This version already has different artifact bytes. Increment the candidate version; never overwrite a release artifact.');
else copyFileSync(join(staging, packed.filename), artifact, constants.COPYFILE_EXCL);
assert.ok(!packed.files.some(file => ['src/remote.mjs', 'src/remote-adapter.mjs'].includes(file.path)), 'Retired SSH execution is still packaged');
mkdirSync(consumer);
execFileSync('npm', ['install', '--prefix', consumer, '--omit=dev', '--ignore-scripts', '--no-fund', '--no-audit',
  ...(values['skip-audit'] ? ['--offline'] : []), artifact], { stdio: 'pipe' });
const installed = join(consumer, 'node_modules/herdr-relay');
assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(installed, 'package.json'))).bin), ['herdr-relay']);
assert.equal(execFileSync(join(consumer, 'node_modules/.bin/herdr-relay'), ['--version'], { encoding: 'utf8' }).trim(), packed.version);
assert.match(execFileSync(join(consumer, 'node_modules/.bin/herdr-relay'), ['upgrade', '--help'], { encoding: 'utf8' }), /upgrade rollback/);
const help = execFileSync(join(consumer, 'node_modules/.bin/herdr-relay'), ['native', '--help'], { encoding: 'utf8', cwd: consumer });
assert.match(help, /interactive grant\|request\|dispatch/);
assert.match(execFileSync(join(consumer, 'node_modules/.bin/herdr-relay'), ['headless', '--help'], { encoding: 'utf8' }), /headless provision/);
const skillConfig = join(root, 'installed-skills'); mkdirSync(skillConfig);
const installedCli = join(consumer, 'node_modules/.bin/herdr-relay');
const installedSkills = JSON.parse(execFileSync(installedCli, ['skills', 'install', '--config-dir', skillConfig], { encoding: 'utf8' }));
assert.equal(installedSkills.state, 'skills_installed');
assert.match(readFileSync(join(skillConfig, 'skills/herdr-relay/SKILL.md'), 'utf8'), /Native Relay does not require Paperclip/);
assert.equal(JSON.parse(execFileSync(installedCli, ['skills', 'install', '--config-dir', skillConfig], { encoding: 'utf8' })).state, 'skills_current');
if (!values['skip-audit']) {
  const activationBin = join(root, 'activation-bin'); mkdirSync(activationBin);
  symlinkSync(join(installed, 'src/cli.mjs'), join(activationBin, 'herdr-relay'));
  const activation = JSON.parse(execFileSync(installedCli, ['release', 'install', '--artifact', artifact, '--sha256', sha(artifact),
    '--upgrade-dir', join(root, 'activation-upgrades'), '--releases-dir', join(root, 'activation-releases'), '--bin-dir', activationBin,
    '--config-dir', skillConfig], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.equal(activation.servicesChanged, false); assert.equal(activation.skills.state, 'skills_current');
}
execFileSync(process.execPath, ['--input-type=module', '-e', `
  import assert from 'node:assert/strict';
  import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
  import {join} from 'node:path';
  import {execFileSync} from 'node:child_process';
  const root=${JSON.stringify(join(root, 'installed-headless'))}; mkdirSync(root);
  const config=join(root,'node.json'), manifest=join(root,'headless.json'), schedule=join(root,'schedule.json');
  writeFileSync(config,JSON.stringify({identityVersion:2,nodeId:'fixture',stateDirectory:root,backend:{url:'http://127.0.0.1:1',token:'fixture'},bindings:[]}));
  writeFileSync(manifest,JSON.stringify({key:'fixture',name:'fixture',directory:root,executable:process.execPath,
    config:{model:'fixture/model',permissions:[{action:'*',resource:'*',effect:'deny'}]},
    schedule:{id:'fixture',instructions:'Fixture only',cron:'0 7-18 * * 1-5',timezone:'Africa/Johannesburg',reviewPolicy:'none'}}));
  const cli=join(process.cwd(),'src/cli.mjs'), args=[cli,'headless','provision','--file',manifest,'--config',config,'--schedule-output',schedule];
  assert.equal(JSON.parse(execFileSync(process.execPath,args)).state,'headless_plan');
  assert.equal(JSON.parse(readFileSync(config)).bindings.length,0);
  const applied=JSON.parse(execFileSync(process.execPath,[...args,'--apply']));
  assert.equal(applied.runtimeStarted,false); assert.equal(applied.scheduleInstalled,false);
  assert.equal(JSON.parse(readFileSync(schedule)).definition.enabled,false);
  assert.equal(JSON.parse(execFileSync(process.execPath,[...args,'--apply'])).agentId,applied.agentId);
`], { cwd: installed, stdio: 'pipe' });
execFileSync(process.execPath, ['--input-type=module', '-e', `
  import assert from 'node:assert/strict';
  await import('./packages/opencode-relay/server.mjs');
  await import('./packages/opencode-relay/tui.mjs');
  await import('@opencode/client/service');
  const {startBackend}=await import('./src/backend-service.mjs');
  const backend=await startBackend({database:':memory:'});
  try { const token=backend.store.bootstrap().token; const response=await fetch(backend.origin+'/v1/info',{headers:{authorization:'Bearer '+token}});
    assert.equal((await response.json()).features.interactiveProvisioning,true); }
  finally { await backend.close(); }
`], { cwd: installed, stdio: 'pipe' });
const sourceMethods = [], taskId = '00000000-0000-4000-8000-000000000001';
const sourceTask = { id: taskId, companyId: 'company', title: 'Surface migration fixture', description: 'Preserved task content', priority: 'high', status: 'in_progress' };
const paperclip = createServer((req, res) => {
  sourceMethods.push(req.method);
  const path = req.url;
  const body = path === '/api/companies' ? [{ id: 'company', name: 'Surface fixture' }] : path.includes('/audit/') ? { accessTier: 'full', items: [] } :
    path.includes('/comments?') || path.endsWith('/interactions') ? [] : path.startsWith('/api/companies/') ? [sourceTask] : sourceTask;
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
});
await new Promise(resolve => paperclip.listen(0, '127.0.0.1', resolve));
let onboarding;
try {
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
    import {join} from 'node:path';
    import {nativeAdmin} from './src/native-admin-cli.mjs';
    import {nativeBackendClient} from './src/backend-client.mjs';
    import {startBackend} from './src/backend-service.mjs';
    import {BackendStore} from './src/backend-store.mjs';
    import {enrolInteractive,attachInteractive} from './src/native-enrol.mjs';
    import {NodeJournal} from './src/node-journal.mjs';
    import {startNodeService} from './src/node-service.mjs';
    import {tickAgentNotices} from './src/node-notices.mjs';
    import {call} from './src/client.mjs';
    const root=${JSON.stringify(root)}, evo=join(root,'Evo'), surface=join(root,'Surface'), state=join(evo,'backend');
    mkdirSync(state,{recursive:true}); mkdirSync(surface);
    const backend=await startBackend({database:join(state,'backend.sqlite')});
    const rootToken=backend.store.bootstrap().token, owner=join(evo,'owner.json');
    writeFileSync(owner,JSON.stringify({userId:'owner',url:backend.origin,token:rootToken}),{mode:0o600});
    const configFile=join(surface,'node/node.json'), operatorFile=join(surface,'node/operator.json');
    const contextDirectory=join(surface,'opencode');
    try {
      for(const name of ['Evo','Surface']) {
        const bundle=join(evo,name+'.bundle');
        await nativeAdmin(['node','bootstrap','--context',owner,'--key','bootstrap-'+name,'--name',name,'--url',backend.origin,'--local-user','--output',bundle]);
        await nativeAdmin(['node','join','--bundle',bundle,'--config',name==='Surface'?configFile:join(evo,'node/node.json')]);
      }
      await nativeAdmin(['node','join','--bundle',join(evo,'Surface.bundle'),'--config',configFile]);
      await nativeAdmin(['plugin','install','--config',configFile,'--config-dir',contextDirectory]);
      await nativeAdmin(['plugin','install','--config',configFile,'--config-dir',contextDirectory]);
      const op=JSON.parse(readFileSync(operatorFile)), config=JSON.parse(readFileSync(configFile));
      assert.notEqual(op.token,rootToken); assert.notEqual(config.backend.token,op.token);
      assert.equal(op.scope.nodeId,config.nodeId); assert.equal(existsSync(join(surface,'owner.json')),false);
      const api=nativeBackendClient(op);
      const session={id:'ses_surface_fixture',projectID:'global',location:{directory:surface},time:{created:1}};
      const dependencies={discover:async()=>({url:'http://127.0.0.1:4096',auth:{type:'basic',username:'opencode',password:'isolated-fixture'}}),
        makeClient:()=>({server:{info:async()=>({version:'2.1.2'})},session:{get:async()=>session}})};
      const input={configFile,directory:surface,sessionId:session.id,name:'Surface chat',reserved:true,api,backend:{url:backend.origin}};
      const enrolled=await enrolInteractive(input,dependencies);
      session.id='ses_surface_replacement';session.time.created=2;
      assert.equal((await attachInteractive({...input,sessionId:session.id,agentId:enrolled.agentId,expectedGeneration:1,key:'replace'},dependencies)).generation,2);
      await assert.rejects(api('POST','/v1/node-credentials',{nodeId:config.nodeId,key:'escalate'}),{code:'forbidden'});
      const evoConfig=JSON.parse(readFileSync(join(evo,'node/node.json'))), rootApi=nativeBackendClient({url:backend.origin,token:rootToken});
      await rootApi('POST','/v1/commands',{key:'message-agent',action:'agent.enrol',payload:{id:'evo-message-agent',nodeId:evoConfig.nodeId,name:'Evo message receiver',directory:evo}});
      await rootApi('POST','/v1/commands',{key:'message-attach',action:'agent.attach',payload:{id:'evo-message-agent',expectedBindingRevision:0,conversationId:'ses_evo_message',bindingId:'evo-message-binding',directory:evo}});
      const sourceJournal=new NodeJournal(join(surface,'node/node.sqlite'),{nodeId:config.nodeId,instanceId:backend.store.instance});
      const targetJournal=new NodeJournal(join(evo,'node/node.sqlite'),{nodeId:evoConfig.nodeId,instanceId:backend.store.instance});
      targetJournal.db.prepare('INSERT INTO settings VALUES (?,?)').run('receiver:evo-message-agent',JSON.stringify({state:'active',bindingId:'evo-message-binding',generation:1}));
      const sender=backend.store.get('agent',enrolled.agentId), messageSocket=join(surface,'message-fixture.sock');
      const service=await startNodeService({journal:sourceJournal,socketPath:messageSocket,api:nativeBackendClient(config.backend),
        workers:[{agentId:sender.id,sessionId:sender.conversationId,bindingId:sender.bindingId,bindingRevision:sender.bindingRevision,token:'fixture-message-token'}]});
      try {
        const sent=await call({socketPath:messageSocket,token:'fixture-message-token'},'POST','/agent/message-send',
          {key:'surface-status',recipientAgentId:'evo-message-agent',kind:'status',body:'Surface fixture status. No work authorised.'});
        assert.equal(sent.state,'recorded');assert.equal(backend.store.all('task').length,0);assert.equal(backend.store.all('execution').length,0);
        targetJournal.reconcileSnapshot(backend.store.snapshot());let sends=0;
        const binding={id:'evo-message-binding',agentId:'evo-message-agent',receiverGeneration:1,identity:{sessionId:'ses_evo_message'},
          native:{snapshot:async()=>({idle:true,inbox:[],messages:[]}),send:async()=>{sends++}},observe:()=>({state:'finished',outcome:'succeeded'})};
        await tickAgentNotices(targetJournal,nativeBackendClient(evoConfig.backend),async()=>binding);
        await tickAgentNotices(targetJournal,nativeBackendClient(evoConfig.backend),async()=>binding);
        assert.equal(sends,1);assert.equal(backend.store.get('message',sent.receipt.id).state,'delivered');
      } finally {await service.close();sourceJournal.close();targetJournal.close();}
      const source=join(surface,'paperclip-source.json'), file=join(surface,'paperclip-export.json');
      await nativeAdmin(['tasks','source','--url',${JSON.stringify(`http://127.0.0.1:${paperclip.address().port}`)},'--local-trusted','--output',source]);
      await nativeAdmin(['tasks','companies','--source',source]);
      await nativeAdmin(['tasks','export','--source',source,'--company','company','--output',file]);
      await nativeAdmin(['tasks','plan','--file',file]);
      await backend.close();
      const digest=JSON.parse(readFileSync(file)).digest;
      const args=['tasks','import','--file',file,'--context',owner,'--state-dir',state,'--confirm-digest',digest,'--source-frozen','--legacy-relay-settled'];
      await nativeAdmin(args); await nativeAdmin(args);
      await nativeAdmin(['backend','backup','--state-dir',state,'--output',join(evo,'backup.sqlite')]);
      await nativeAdmin(['backend','install','--state-dir',join(root,'dry-run-only'),'--dry-run']);
      assert.equal(existsSync(join(root,'dry-run-only')),false);
      const store=new BackendStore(join(state,'backend.sqlite'));
      try { assert.equal(store.all('task').length,1); assert.equal(store.all('task')[0].status,'todo');assert.equal(store.all('execution').length,0);assert.equal(store.all('schedule').length,0); }
      finally {store.close();}
      console.log('ONBOARDING_SMOKE='+JSON.stringify({cleanEvoAndSurfaceHomes:true,scopedBootstrapAndJoin:true,operatorEnrolAndAttach:true,
        pluginInstallWithoutSession:true,sourceExportReadOnly:true,taskImportIdempotent:true,backendBackupPassed:true,systemdUnitDryRunPassed:true,
        taskIndependentAgentMessages:true,physicalSurfaceTested:false,rootCredentialCopied:false}));
    } finally {await backend.close();}
  `], { cwd: installed, timeout: 60000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, HOME: join(root, 'clean-home'), XDG_STATE_HOME: join(root, 'clean-state'), XDG_CONFIG_HOME: join(root, 'clean-config'), RELAY_NATIVE_CONTEXT: '' } });
  onboarding = JSON.parse(result.stdout.split('\n').find(line => line.startsWith('ONBOARDING_SMOKE=')).slice('ONBOARDING_SMOKE='.length));
  assert.ok(sourceMethods.length > 0 && sourceMethods.every(method => method === 'GET'));
} finally { await new Promise(resolve => paperclip.close(resolve)); }
const audit = values['skip-audit'] ? null : JSON.parse(execFileSync('npm', ['audit', '--omit=dev', '--json'], { cwd: consumer, encoding: 'utf8' }));
if (audit) assert.equal(audit.metadata.vulnerabilities.total, 0);
const result = { version: packed.version, artifact, sha256: sha(artifact), sourceCommit, sourceTreeClean, releaseVerified: Boolean(values.release && audit), verifiedOn: new Date().toISOString(),
  cleanProductionInstall: true, cliEntrypointPassed: true, serverAndTuiImportsPassed: true, nativeBackendStarted: true,
  onboarding,
  skillInstallPassed: true, cliSkillSyncPassed: !values['skip-audit'],
  auditVerified: Boolean(audit), vulnerabilities: audit?.metadata.vulnerabilities ?? null, published: false, gitTagCreated: false };
writeFileSync(join(artifactDirectory, `${packed.filename}.verification.json`), JSON.stringify(result, null, 2));
const sums = `${result.sha256}  ${packed.filename}\n`, sumsPath = join(artifactDirectory, 'SHA256SUMS');
if (existsSync(sumsPath)) assert.equal(readFileSync(sumsPath,'utf8'),sums,'Existing release checksums differ. Use a separate versioned artifact directory.');
else writeFileSync(sumsPath,sums,{flag:'wx'});
console.log(JSON.stringify(result, null, 2));
