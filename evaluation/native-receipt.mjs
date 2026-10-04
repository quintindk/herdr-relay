// Narrow CLI used by the native agents. Credentials are not passed through prompts.
import fs from 'node:fs';
const [bindingPath, answer] = process.argv.slice(2);
if (!bindingPath?.startsWith('/tmp/opencode/retinue-native/') || !answer) throw new Error('Binding and answer required');
const binding = JSON.parse(fs.readFileSync(bindingPath, 'utf8'));
if (binding.product === 'openrig') {
  const headers = { 'Content-Type': 'application/json', 'X-OpenRig-Session': binding.address };
  const claim = await fetch(`${binding.api}/api/queue/${binding.itemId}/claim`, { method: 'POST', headers, body: '{}' });
  if (!claim.ok) throw new Error(await claim.text());
  const response = await fetch(`${binding.api}/api/queue/${binding.itemId}/update`, { method: 'POST', headers,
    body: JSON.stringify({ state: 'done', closureReason: 'no-follow-on', transitionNote: `Native ${binding.harness} receipt: ${answer}` }) });
  const data = await response.json();
  fs.writeFileSync(bindingPath + '.receipt', JSON.stringify({ status: response.status, itemId: binding.itemId, answer, state: data.state }));
  if (!response.ok) throw new Error(JSON.stringify(data));
  console.log(JSON.stringify({ recorded: true, state: data.state }));
  process.exit(0);
}
const response = await fetch(`${binding.api}/api/issues/${binding.issueId}/comments`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${binding.token}`, 'X-Paperclip-Run-Id': binding.runId },
  body: JSON.stringify({ body: `Native ${binding.harness} receipt: ${answer}`, clientRequestId: binding.deliveryId }),
});
const body = await response.json();
fs.writeFileSync(bindingPath + '.receipt', JSON.stringify({ status: response.status, commentId: body.id, answer, runId: binding.runId }));
if (!response.ok) throw new Error(JSON.stringify(body));
console.log(JSON.stringify({ recorded: true, commentId: body.id }));
