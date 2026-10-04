import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const evidence = [];
function cli(label, args) {
  try { const output = execFileSync('rig', args, { encoding: 'utf8' }); evidence.push({ label, status: 0, output }); return JSON.parse(output); }
  catch (e) { evidence.push({ label, status: e.status, output: e.stdout?.toString(), error: e.stderr?.toString() }); }
}
const before = cli('S3 worker remains running after typed acceptance', ['ps', '--nodes', '--rig', 'graph', '--json']);
if (before?.[0]?.rigId) cli('S3 explicit runtime retirement (separate coordinator operation)', ['remove', before[0].rigId, 'main.lead', '--json']);
cli('S3 worker state after explicit retirement', ['ps', '--nodes', '--rig', 'graph', '--json']);
cli('S3 unrelated project still running', ['ps', '--nodes', '--rig', 'project', '--json']);
fs.writeFileSync('/home/node/openrig-retire-evidence.json', JSON.stringify(evidence,null,2));
console.log(JSON.stringify(evidence,null,2));
