// Integration smoke test against wrangler dev --local only. Never contacts production.
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const BASE = 'ws://127.0.0.1:8787';
const suffix = require('node:crypto').randomBytes(6).toString('hex');
const room = 'test-' + suffix;
const light = { on: true, code: 'test' + suffix, map: { red: 1, yellow: 2, blue: 4, green: 3 } };
const sockets = [];
async function open(path) {
  const ws = new WebSocket(BASE + path, { headers: { Origin: 'http://localhost' } });
  sockets.push(ws);
  ws.messages = [];
  ws.on('message', data => { if (data.toString() !== 'pong') ws.messages.push(JSON.parse(data)); });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.sendJson = value => ws.send(JSON.stringify(value));
  return ws;
}
function waitFor(ws, predicate) {
  return new Promise((resolve, reject) => {
    const inspect = () => {
      const m = ws.messages.find(predicate);
      if (m) { clearTimeout(timeout); ws.off('message', inspect); resolve(m); }
    };
    const timeout = setTimeout(() => { ws.off('message', inspect); reject(new Error('Local test timed out')); }, 5000);
    ws.on('message', inspect); inspect();
  });
}
(async () => {
  try {
    const phone = await open('/lobby');
    phone.sendJson({ t: 'enter', c: 'a' + suffix.slice(0, 10), name: 'Simulated phone', room, light });
    const identity = await waitFor(phone, m => m.t === 'you');
    const pc = await open('/lobby');
    pc.sendJson({ t: 'enter', c: 'b' + suffix.slice(0, 10), name: 'Simulated computer' });
    await waitFor(pc, m => m.t === 'you');
    pc.sendJson({ t: 'join', target: identity.id, code: identity.code });
    const paired = await waitFor(pc, m => m.t === 'paired');
    assert.equal(paired.room, room);
    assert.deepEqual(paired.light, light);
    assert.equal((await waitFor(phone, m => m.t === 'paired')).room, room);
    phone.sendJson({ t: 'ok' }); pc.sendJson({ t: 'ok' });
    // The phone is a temporary pairing source, not a primary controller or gateway.
    await new Promise(resolve => { phone.once('close', resolve); phone.close(); });

    // A controller listening in the original issue room still receives a PC update.
    const oldController = await open('/ws?room=' + room);
    oldController.sendJson({ t: 'hello', issues: [], since: 0 });
    await waitFor(oldController, m => m.t === 'snap' && m.done);
    const pcSync = await open('/ws?room=' + paired.room);
    pcSync.sendJson({ t: 'hello', issues: [], since: 0 });
    await waitFor(pcSync, m => m.t === 'snap' && m.done);
    const issue = { id: 'local-issue', v: 1, vc: 'pc', severity: 'red' };
    pcSync.sendJson({ t: 'up', issues: [issue] });
    assert.deepEqual((await waitFor(oldController, m => m.t === 'up')).issues, [issue]);

    // The separate light service also reaches a simulated device using the shared code.
    const tower = await open('/light?code=' + light.code + '&d=1');
    const pcLight = await open('/light?code=' + paired.light.code);
    pcLight.sendJson({ t: 'hb' });
    assert.equal((await waitFor(pcLight, m => m.t === 'dev' && m.n === 1)).n, 1);
    pcLight.sendJson({ t: 'set', a: [paired.light.map.red], b: [], m: 'flash' });
    const output = await waitFor(tower, m => m.t === 'light');
    assert.deepEqual(output.a, [1]);
    assert.equal(output.m, 'flash');
    console.log('PASS: after the phone disconnects, the real local Worker preserves the room, syncs PC issues, and reaches the simulated tower.');
  } finally {
    for (const ws of sockets) ws.terminate();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
