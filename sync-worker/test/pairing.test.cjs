// Offline regression tests: no production sockets, room IDs, or physical relay commands.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
const worker = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
const light = { on: true, code: 'testlight123', map: { red: 1, yellow: 2, blue: 4, green: 3 } };
const plain = value => JSON.parse(JSON.stringify(value));

function makeLobby() {
  const storage = new Map(), sockets = [];
  const ctx = {
    setWebSocketAutoResponse() {},
    getWebSockets: () => sockets,
    storage: {
      get: async key => storage.get(key),
      put: async (key, value) => storage.set(key, plain(value)),
      delete: async key => storage.delete(key),
      list: async ({ prefix }) => new Map([...storage].filter(([key]) => key.startsWith(prefix)))
    }
  };
  const env = vm.createContext({
    DurableObject: class { constructor(ctx) { this.ctx = ctx; } },
    WebSocketRequestResponsePair: class {}, crypto: webcrypto, Date, URL, queueMicrotask
  });
  vm.runInContext(worker.replace(/import \{ DurableObject \} from 'cloudflare:workers';/, '')
    .replace('export default {', 'const handler = {').replaceAll('export class ', 'class ')
    + '\nglobalThis.LobbyClass = Lobby;', env);
  const lobby = new env.LobbyClass(ctx, {});
  const message = (socket, data) => lobby.webSocketMessage(socket, JSON.stringify(data));
  const enter = async data => {
    const socket = { attachment: null, messages: [],
      serializeAttachment(a) { this.attachment = plain(a); },
      deserializeAttachment() { return this.attachment && plain(this.attachment); },
      send(data) { this.messages.push(JSON.parse(data)); },
      close() { sockets.splice(sockets.indexOf(this), 1); }
    };
    sockets.push(socket);
    await message(socket, { t: 'enter', ...data });
    return socket;
  };
  const pair = async (joiner, host) => {
    await message(joiner, { t: 'join', target: host.attachment.id, code: host.attachment.code });
    return joiner.messages.filter(m => m.t === 'paired').at(-1);
  };
  return { enter, message, pair, storage };
}

test('adding computers keeps the tower room and passes enabled light settings', async () => {
  const l = makeLobby();
  const phone = await l.enter({ name: 'Phone', c: 'phone1', room: 'existing-tower-room', light });
  const pc = await l.enter({ name: 'PC', c: 'pc1' });
  const paired = await l.pair(pc, phone);
  assert.equal(paired.room, 'existing-tower-room');
  assert.deepEqual(paired.light, light);
  assert.equal(paired.pv, 2);
  assert.equal(phone.messages.filter(m => m.t === 'paired').at(-1).room, paired.room);
  const secondPc = await l.enter({ name: 'PC2', c: 'pc2' });
  assert.equal((await l.pair(secondPc, phone)).room, paired.room);
  // A duplicate submit must not allocate another group.
  assert.equal((await l.pair(pc, phone)).room, paired.room);
});

test('selecting a fresh computer also retains the existing caller room', async () => {
  const l = makeLobby();
  const phone = await l.enter({ c: 'phone1', room: 'tower-room', light });
  const fresh = await l.enter({ c: 'pc1' });
  const p = await l.pair(phone, fresh);
  assert.equal(p.room, 'tower-room');
  assert.deepEqual(p.light, light);
});

test('selected host group and light settings take precedence when joining another group', async () => {
  const l = makeLobby();
  const host = await l.enter({ c: 'host1', room: 'host-room', light });
  const joiner = await l.enter({ c: 'pc1', room: 'other-room', light: { ...light, code: 'otherlight1' } });
  const p = await l.pair(joiner, host);
  assert.equal(p.room, 'host-room');
  assert.equal(p.light.code, light.code);
});

test('fresh and legacy clients can still create a group', async () => {
  const l = makeLobby();
  const a = await l.enter({ c: 'fresh1' }), b = await l.enter({ c: 'fresh2' });
  const p = await l.pair(a, b);
  assert.match(p.room, /^[a-f0-9]{24}$/);
  assert.equal(p.light, null);
});

test('wrong PIN and public lobby listings do not disclose room or light credentials', async () => {
  const l = makeLobby();
  const a = await l.enter({ name: 'Phone', c: 'phone1', room: 'secret-room', light });
  const b = await l.enter({ name: 'PC', c: 'pc1' });
  await l.message(b, { t: 'join', target: a.attachment.id, code: 'wrong' });
  assert.equal(b.messages.at(-1).e, 'code');
  assert.equal(b.messages.some(m => m.t === 'paired'), false);
  assert.equal(l.storage.size, 0);
  const listing = b.messages.filter(m => m.t === 'list');
  assert.equal(JSON.stringify(listing).includes('secret-room'), false);
  assert.equal(JSON.stringify(listing).includes(light.code), false);
});

test('reconnecting after a missed pairing retains the same room and light configuration', async () => {
  const l = makeLobby();
  const a = await l.enter({ c: 'phone1', room: 'tower-room', light });
  const b = await l.enter({ c: 'pc1' });
  await l.pair(b, a);
  const resumed = await l.enter({ c: 'phone1' });
  const p = resumed.messages.find(m => m.t === 'paired');
  assert.equal(p.room, 'tower-room');
  assert.deepEqual(p.light, light);
  assert.equal(p.pv, 2);
});

test('invalid room IDs and relay maps are not carried into a pairing', async () => {
  const l = makeLobby();
  const a = await l.enter({ c: 'a', room: 'invalid?room', light: { ...light, map: { ...light.map, red: 99 } } });
  const b = await l.enter({ c: 'b' });
  const p = await l.pair(a, b);
  assert.match(p.room, /^[a-f0-9]{24}$/);
  assert.equal(p.light, null);
});

function browserEnv(seed = {}, { room = 'tower-room', settings = false, initialLight = light } = {}) {
  const saved = new Map(Object.entries({ 'gluer.room': room, 'gluerIssueAlert.cid': 'testpc', ...seed }));
  const sockets = [], timers = [], elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { id, value: '', textContent: '', innerHTML: '', focus() {} });
    return elements.get(id);
  };
  class Socket {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(data) { this.sent.push(data === 'ping' ? data : JSON.parse(data)); }
    close() { this.readyState = 3; if (this.onclose) this.onclose({ code: 1000 }); }
    open() { this.readyState = 1; this.onopen?.(); }
    receive(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
  }
  let ctx;
  const env = {
    localStorage: { getItem: k => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, String(v)) },
    location: { href: 'https://example.test/?room=' + room, search: '?room=' + room },
    history: { replaceState(_a, _b, url) { env.replacedUrl = url; } },
    URL, URLSearchParams, crypto: webcrypto, Date: class extends Date {},
    WebSocket: Socket, setTimeout: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
    clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    document: { querySelectorAll: () => [], getElementById: element,
      querySelector: () => null, addEventListener() {}, visibilityState: 'visible' },
    window: { addEventListener() {} },
    issues: [], STORE_KEY: 'test.issues', DEFAULT_SYNC_URL: 'wss://offline.test/ws',
    view: { name: settings ? 'settings' : 'home' }, pk: a => a[0], lg: a => a[0],
    modal: html => { env.modalHtml = html; }, render() {}, toastL() {},
    closeModal: () => { env.modalHtml = ''; ctx.Sync.lobbyClose(); ctx.Sync.flush(); },
    Light: { applyCount: 0, apply() { this.applyCount++; }, pairing: () => initialLight,
      acceptPairing(s) { env.acceptedLight = plain(s); assert.equal(ctx.Sync.ready(), false); } },
    Sync: null, overall: () => 'green', isOpen: () => true
  };
  ctx = vm.createContext(env);
  return { ctx, env, saved, sockets, timers, element };
}
function makeSync(options) {
  const b = browserEnv({}, options);
  const src = html.slice(html.indexOf('Sync = (() => {'), html.indexOf('/* ---------- keyboard shortcuts'));
  vm.runInContext(src, b.ctx);
  return b;
}

test('Add Device and cancel preserve the saved room and active sync socket', () => {
  const b = makeSync();
  b.timers.find(t => t.delay === 0).fn(); b.sockets[0].open();
  b.ctx.Sync.addDevice();
  const lobby = b.sockets.at(-1); lobby.open();
  const enter = lobby.sent.find(m => m.t === 'enter');
  assert.equal(enter.room, 'tower-room');
  assert.deepEqual(plain(enter.light), light);
  b.ctx.Sync.lobbyClose();
  assert.equal(b.saved.get('gluer.room'), 'tower-room');
  assert.equal(b.sockets[0].readyState, 1);
});

test('old service response cannot replace an existing room', () => {
  const b = makeSync(); b.ctx.Sync.addDevice();
  const lobby = b.sockets.at(-1); lobby.open();
  lobby.receive({ t: 'paired', room: 'unexpected-new-room', peer: 'Phone' });
  assert.equal(b.saved.get('gluer.room'), 'tower-room');
  assert.match(b.element('lberr').textContent, /needs an update/);
});

test('verified pairing transfers light settings and prevents an old URL restoring the wrong group', () => {
  const b = makeSync(); b.ctx.Sync.addDevice();
  const lobby = b.sockets.at(-1); lobby.open();
  lobby.receive({ t: 'paired', pv: 2, room: 'selected-host-room', peer: 'Phone', light });
  assert.equal(b.saved.get('gluer.room'), 'selected-host-room');
  assert.deepEqual(b.env.acceptedLight, light);
  assert.equal(b.env.replacedUrl, '/?room=selected-host-room');
});

test('incoming issues update the light even while Settings delays page rendering', () => {
  const b = makeSync({ settings: true });
  b.timers.find(t => t.delay === 0).fn(); const sync = b.sockets[0]; sync.open();
  assert.equal(b.ctx.Sync.ready(), false);
  sync.receive({ t: 'snap', done: 1, issues: [] });
  assert.equal(b.ctx.Sync.ready(), true);
  const before = b.ctx.Light.applyCount;
  sync.receive({ t: 'up', issues: [{ id: 'issue1', v: 1, color: 'red' }] });
  assert.ok(b.ctx.Light.applyCount > before);
  sync.close();
  assert.equal(b.ctx.Sync.ready(), false);
});

test('a newly connected browser cannot send stale green before its issue snapshot arrives', () => {
  const b = browserEnv({ 'gluer.light': JSON.stringify(light) });
  let ready = false;
  b.ctx.Sync = { cfg: () => ({ room: 'tower-room' }), ready: () => ready };
  const start = html.indexOf('Light = (() => {');
  vm.runInContext(html.slice(start, html.indexOf('const LIGHT_NAMES', start)), b.ctx);
  b.ctx.Light.apply(); const socket = b.sockets[0]; socket.open();
  assert.equal(socket.sent.some(m => m.t === 'set'), false);
  ready = true; b.ctx.Light.apply();
  assert.deepEqual(plain(socket.sent.find(m => m.t === 'set')), { t: 'set', a: [3], b: [], m: 'steady' });
});

test('light pairing configuration preserves relay mapping and defers output until sync', () => {
  const b = browserEnv({ 'gluer.light': JSON.stringify({ on: false }) });
  b.ctx.Sync = { cfg: () => ({ room: 'tower-room' }), ready: () => false };
  const start = html.indexOf('Light = (() => {');
  vm.runInContext(html.slice(start, html.indexOf('const LIGHT_NAMES', start)), b.ctx);
  b.ctx.Light.acceptPairing(light);
  assert.deepEqual(plain(b.ctx.Light.pairing()), light);
  assert.equal(b.sockets.length, 0);
  b.ctx.Light.acceptPairing({ ...light, map: { ...light.map, red: 99 } });
  assert.deepEqual(plain(b.ctx.Light.pairing()), light);
});

test('complete inline application script parses', () => {
  new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
});
