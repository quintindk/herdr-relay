import fs from 'node:fs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const root='/tmp/opencode/retinue-native';
const read=name=>JSON.parse(fs.readFileSync(`${root}/${name}-evidence.json`,'utf8'));
const clean=data=>JSON.parse(JSON.stringify(data,(key,value)=>['codex_reasoning_items','codex_message_items','metadata','token'].includes(key)?undefined:value));
const paperclip=clean(read('bridge'));
const openrig=[...clean(read('openrig')), ...clean(read('openrig-opencode'))];
for(const harness of ['opencode','hermes']) {
  const p=paperclip.find(x=>x.test===`${harness} existing conversation to Paperclip`);
  assert(p.contextRecalled);
  assert.equal(p.receipt.status,201);
  assert.equal(p.attributedComment.authorAgentId,p.agentId);
  assert.equal(p.attributedComment.createdByRunId,p.runId);
  const o=openrig.find(x=>x.test===`${harness} existing conversation to OpenRig queue`);
  assert(o.contextRecalled);
  assert.equal(o.receipt.state,'done');
  assert(o.transitions.some(t=>t.state==='done' && t.actorSession===o.address));
}
const runtimeProbes=[];
for(const harness of ['opencode','hermes']) {
  try{runtimeProbes.push({harness,exit:0,output:execFileSync('docker',['exec','retinue-eval-openrig','rig','create',`unsupported-${harness}`,'--runtime',harness],{encoding:'utf8',stdio:['ignore','pipe','pipe']})});}
  catch(e){runtimeProbes.push({harness,exit:e.status,stdout:e.stdout.toString(),stderr:e.stderr.toString()});}
}
assert(runtimeProbes.every(p=>(p.stdout||p.output||'').includes('unsupported runtime') || (p.stderr||'').includes('unsupported runtime')));
const result={date:new Date().toISOString(),assertions:'passed',paperclip,openrig,runtimeProbes};
fs.writeFileSync(new URL('../docs/evidence/native-conversation-results.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({assertions:'passed',paperclipNativeHarnesses:2,openrigQueueNativeHarnesses:2,runtimeProbes},null,2));
