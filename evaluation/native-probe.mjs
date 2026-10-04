import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root = '/tmp/opencode/retinue-native';
const evidence = [];
const statePath = `${root}/sessions.json`;
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
async function http(base, method, path, body) {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(240000) });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(data)}`);
  return data;
}
const oc = (method,path,body) => http('http://127.0.0.1:17401',method,path,body);
class Hermes {
  constructor() { this.frames=[]; this.pending=new Map(); this.next=0; }
  async connect() {
    this.ws=new WebSocket('ws://127.0.0.1:17402/api/ws?token='+fs.readFileSync(`${root}/hermes/gateway-token`,'utf8'));
    this.ws.addEventListener('message', event=>{for(const line of String(event.data).split('\n').filter(Boolean)) {
      const frame=JSON.parse(line); this.frames.push(frame);
      if(frame.id && this.pending.has(frame.id)) {const {resolve,reject,timer}=this.pending.get(frame.id);clearTimeout(timer);this.pending.delete(frame.id);frame.error?reject(new Error(JSON.stringify(frame.error))):resolve(frame.result);}
    }});
    await new Promise((resolve,reject)=>{this.ws.addEventListener('open',resolve,{once:true});this.ws.addEventListener('error',reject,{once:true});});
  }
  call(method,params={}) { return new Promise((resolve,reject)=> {const id=++this.next; const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`RPC timeout ${method}`));},240000);this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({jsonrpc:'2.0',id,method,params}));}); }
  async wait(sid) {for(let i=0;i<240;i++){await new Promise(r=>setTimeout(r,1000));const s=await this.call('session.activate',{session_id:sid});if(!s.running && !['working','starting','streaming'].includes(s.status))return s;}throw new Error('Hermes turn timeout');}
}
const hermes=new Hermes();
const mode=process.argv[2]||'seed';
try {
  await hermes.connect();
  if(mode!=='seed' && state.hermes) {
    try { await hermes.call('session.activate',{session_id:state.hermes.id}); }
    catch(error) {
      const resumed=await hermes.call('session.resume',{session_id:state.hermes.storedId});
      evidence.push({test:'Hermes explicit resume after live binding expired',previousRuntimeId:state.hermes.id,storedId:state.hermes.storedId,resumedRuntimeId:resumed.session_id});
      state.hermes.id=resumed.session_id;
      fs.writeFileSync(statePath,JSON.stringify(state),{mode:0o600});
    }
  }
  if(mode==='seed') {
    if(state.opencode || state.hermes) throw new Error('Seed already exists. Use bridge phase.');
    const token=`context-${randomUUID().slice(0,8)}`;
    const os=await oc('POST','/session',{title:'Retinue native continuity evaluation'});
    state.opencode={id:os.id,token};
    fs.writeFileSync(statePath,JSON.stringify(state),{mode:0o600});
    const oa=await oc('POST',`/session/${os.id}/message`,{model:{providerID:'github-copilot',modelID:'gpt-6-astra'},parts:[{type:'text',text:`This is an isolated continuity test. Remember the exact private word ${token} in this conversation. Do not write it to files or use tools. Reply ACK only.`}]});
    evidence.push({test:'OpenCode existing conversation seeded',sessionId:os.id,response:oa.parts?.filter(p=>p.type==='text').map(p=>p.text),error:oa.info?.error});
    const hs=await hermes.call('session.create',{cwd:`${root}/hermes`,title:'Retinue native continuity evaluation',model:'gpt-6-astra',provider:'copilot'});
    const htoken=`context-${randomUUID().slice(0,8)}`;
    state.hermes={id:hs.session_id,storedId:hs.stored_session_id,token:htoken};
    fs.writeFileSync(statePath,JSON.stringify(state),{mode:0o600});
    await hermes.call('prompt.submit',{session_id:hs.session_id,text:`This is an isolated continuity test. Remember the exact private word ${htoken} in this conversation. Do not write it to files or use tools. Reply ACK only.`});
    const end=await hermes.wait(hs.session_id);
    evidence.push({test:'Hermes existing conversation seeded',sessionId:hs.session_id,storedId:hs.stored_session_id,status:end.status,messages:end.messages,errorEvents:hermes.frames.filter(f=>f.params?.type?.includes('error'))});
  } else if(mode==='openrig') {
    const ip=execFileSync('docker',['inspect','retinue-eval-openrig','--format','{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'],{encoding:'utf8'}).trim();
    const api=`http://${ip}:17411`;
    for(const harness of (process.argv[3]?[process.argv[3]]:['opencode','hermes'])) {
      const native=state[harness], address=`${harness}@native-control`, itemId=`native-${harness}-${randomUUID()}`;
      const created=await fetch(`${api}/api/queue/create`,{method:'POST',headers:{'Content-Type':'application/json','X-OpenRig-Session':'main-lead@native-control'},body:JSON.stringify({qitemId:itemId,destinationSession:address,body:'Recall existing native context and report',nudge:false})});
      if(!created.ok)throw new Error(await created.text());
      const bindingPath=`${root}/${harness}/openrig-binding.json`;
      fs.writeFileSync(bindingPath,JSON.stringify({product:'openrig',api,itemId,address,harness}),{mode:0o600});
      const prompt=`An independent OpenRig work queue is now connected to this same conversation. Recall the private word from the first exchange. Run one terminal/bash command: node /home/quintin/play/herdr-retinue/evaluation/native-receipt.mjs ${bindingPath} YOUR_RECALLED_WORD . Replace YOUR_RECALLED_WORD with that word. Do not read the binding file. The helper claims and completes only this fixture queue item. Reply REPORTED.`;
      let snapshot;
      if(harness==='opencode')snapshot=await oc('POST',`/session/${native.id}/message`,{model:{providerID:'github-copilot',modelID:'gpt-6-astra'},parts:[{type:'text',text:prompt}]});
      else{await hermes.call('prompt.submit',{session_id:native.id,text:prompt});snapshot=await hermes.wait(native.id);}
      const receipt=fs.existsSync(bindingPath+'.receipt')?JSON.parse(fs.readFileSync(bindingPath+'.receipt','utf8')):null;
      const transitions=await http(api,'GET',`/api/queue/${itemId}/transitions`);
      evidence.push({test:`${harness} existing conversation to OpenRig queue`,nativeSessionId:native.id,itemId,address,receipt,contextRecalled:receipt?.answer===native.token,transitions,nativeResponse:harness==='opencode'?snapshot.parts:snapshot.messages});
      fs.unlinkSync(bindingPath);
    }
  } else {
    const pc='http://172.17.0.2:17410';
    const companies=await http(pc,'GET','/api/companies'); const company=companies.find(c=>c.name==='Retinue evaluation').id;
    for(const harness of ['opencode','hermes']) {
      const native=state[harness];
      const agent=await http(pc,'POST',`/api/companies/${company}/agents`,{name:`Native ${harness} ${Date.now()}`,adapterType:'process',adapterConfig:{command:'node',args:['/evaluation/native-lease.mjs'],timeoutSec:300},runtimeConfig:{heartbeat:{enabled:false,wakeOnDemand:false,maxConcurrentRuns:1}}});
      const issue=await http(pc,'POST',`/api/companies/${company}/issues`,{title:`Recall existing ${harness} context and report`,assigneeAgentId:agent.id});
      await http(pc,'PATCH',`/api/agents/${agent.id}`,{runtimeConfig:{heartbeat:{enabled:true,wakeOnDemand:true,intervalSec:0,maxConcurrentRuns:1}}});
      const run=await http(pc,'POST',`/api/agents/${agent.id}/heartbeat/invoke`,{reason:'native_continuity_evaluation',payload:{issueId:issue.id,taskId:issue.id}});
      let lease;
      for(let i=0;i<40;i++){try{lease=JSON.parse(execFileSync('docker',['exec','retinue-eval-paperclip','node','-e','process.stdout.write(require("fs").readFileSync(process.argv[1],"utf8"))',`/home/node/native-${agent.id}.json`],{encoding:'utf8',stdio:['ignore','pipe','ignore']}));break;}catch{await new Promise(r=>setTimeout(r,500));}}
      if(!lease)throw new Error('Paperclip run lease unavailable');
      await http(pc,'PATCH',`/api/agents/${agent.id}`,{runtimeConfig:{heartbeat:{enabled:false,wakeOnDemand:false,maxConcurrentRuns:1}}});
      const bindingPath=`${root}/${harness}/binding.json`;
      fs.writeFileSync(bindingPath,JSON.stringify({...lease,api:pc,issueId:issue.id,harness,deliveryId:randomUUID()}),{mode:0o600});
      const prompt=`A task system has now connected to this EXISTING conversation. Do not create a new session. Recall the private word from our earlier exchange (not repeated here). Run exactly one shell command using your terminal/bash tool: node /home/quintin/play/herdr-retinue/evaluation/native-receipt.mjs ${bindingPath} YOUR_RECALLED_WORD . Replace YOUR_RECALLED_WORD with the exact word. This helper records a task comment using a scoped credential file, do not read or display that file. Then reply REPORTED. Do not create other files.`;
      let snapshot;
      if(harness==='opencode') snapshot=await oc('POST',`/session/${native.id}/message`,{model:{providerID:'github-copilot',modelID:'gpt-6-astra'},parts:[{type:'text',text:prompt}]});
      else {await hermes.call('prompt.submit',{session_id:native.id,text:prompt});snapshot=await hermes.wait(native.id);}
      const receipt=fs.existsSync(bindingPath+'.receipt')?JSON.parse(fs.readFileSync(bindingPath+'.receipt','utf8')):null;
      const comments=await http(pc,'GET',`/api/issues/${issue.id}/comments`);
      evidence.push({test:`${harness} existing conversation to Paperclip`,nativeSessionId:native.id,runId:run.id,agentId:agent.id,issueId:issue.id,receipt,contextRecalled:receipt?.answer===native.token,attributedComment:comments.find(c=>c.id===receipt?.commentId),nativeResponse:harness==='opencode'?snapshot.parts:snapshot.messages});
      execFileSync('docker',['exec','retinue-eval-paperclip','node','-e','require("fs").writeFileSync(process.argv[1],"done")',`/home/node/native-${agent.id}.json.done`]);
      fs.unlinkSync(bindingPath);
    }
  }
} catch(error) { evidence.push({test:mode,error:String(error)});process.exitCode=1; }
finally {
  hermes.ws?.close();
  // Keep only visible transcript fields. Provider opaque payloads and reasoning
  // blobs are irrelevant to continuity/attribution evidence.
  const clean=JSON.parse(JSON.stringify(evidence,(key,value)=>['codex_reasoning_items','codex_message_items','metadata'].includes(key)?undefined:value));
  fs.writeFileSync(`${root}/${mode}${process.argv[3]?'-'+process.argv[3]:''}-evidence.json`,JSON.stringify(clean,null,2));
  console.log(JSON.stringify(clean.map(({nativeResponse,attributedComment,messages,...rest})=>({...rest,commentAttribution:attributedComment?{id:attributedComment.id,authorAgentId:attributedComment.authorAgentId,createdByRunId:attributedComment.createdByRunId}:undefined})),null,2));
}
