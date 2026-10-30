/* Gluer Issue Alert – realtime sync hub.
   One Durable Object per "room" keeps the shared list of issues and relays every change
   to every connected tablet over a WebSocket. It stores data only; it never deletes anything.
   Free-tier friendly: hibernating WebSockets + automatic ping/pong that does not wake the object. */
import { DurableObject } from 'cloudflare:workers';

const ALLOWED_ORIGINS = ['https://anthonymancino222.github.io', 'http://localhost', 'http://127.0.0.1'];

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname !== '/ws' && url.pathname !== '/lobby' && url.pathname !== '/light') return new Response('Gluer Issue Alert sync is running.', { status: 200 });
    const origin = req.headers.get('Origin') || '';
    const isDevice = url.pathname === '/light' && url.searchParams.get('d') === '1';   // the relay board has no browser Origin; its light code is the secret
    if (!isDevice && !ALLOWED_ORIGINS.some(o => origin === o || origin.startsWith(o + ':'))) return new Response('forbidden', { status: 403 });
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    if (url.pathname === '/light') {
      const code = (url.searchParams.get('code') || '').toLowerCase();
      if (!/^[a-z0-9]{8,24}$/.test(code)) return new Response('bad light code', { status: 400 });
      return env.LIGHT.get(env.LIGHT.idFromName('light-' + code)).fetch(req);
    }
    if (url.pathname === '/lobby') return env.LOBBY.get(env.LOBBY.idFromName('lobby')).fetch(req);
    const room = (url.searchParams.get('room') || '').toLowerCase();
    if (!/^[a-z0-9_-]{3,40}$/.test(room)) return new Response('bad room code', { status: 400 });
    return env.HUB.get(env.HUB.idFromName(room)).fetch(req);
  }
};

const newer = (a, b) => (a.v || 0) > (b.v || 0) || ((a.v || 0) === (b.v || 0) && String(a.vc || '') > String(b.vc || ''));

const pad = n => String(n).padStart(10, '0');
const pub = r => { const { _s, ...x } = r; return x; };          // the server's change counter never leaves the server
const CHUNK = 150;

export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch() {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  /* Every accepted change gets the next number (_s) and an index entry "q:<number>", so a tablet that
     reconnects can ask "what changed since number N?" and the hub reads only those few rows. */
  async merge(list) {
    const accepted = [], back = [], acks = {};
    let seq = (await this.ctx.storage.get('seq')) || 0;
    for (const r of list) {
      if (!r || typeof r.id !== 'string' || r.id.length > 40) continue;
      acks[r.id] = r.v || 0;
      const key = 'i:' + r.id;
      const cur = await this.ctx.storage.get(key);
      if (!cur || newer(r, cur)) {
        seq++;
        const rec = { ...pub(r), _s: seq };
        if (cur && cur._s) await this.ctx.storage.delete('q:' + pad(cur._s));
        await this.ctx.storage.put({ [key]: rec, ['q:' + pad(seq)]: r.id });
        accepted.push(pub(rec));
      } else if (newer(cur, r)) back.push(pub(cur));
    }
    if (accepted.length) await this.ctx.storage.put('seq', seq);
    return { accepted, back, acks, seq };
  }

  async changedSince(since) {
    if (!since) return [...(await this.ctx.storage.list({ prefix: 'i:' })).values()].map(pub);
    const idx = await this.ctx.storage.list({ prefix: 'q:', start: 'q:' + pad(since + 1) });
    const keys = [...idx.values()].map(id => 'i:' + id);
    const out = [];
    for (let k = 0; k < keys.length; k += 100) for (const v of (await this.ctx.storage.get(keys.slice(k, k + 100))).values()) out.push(pub(v));
    return out;
  }

  others(except) { return this.ctx.getWebSockets().filter(w => w !== except); }
  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (e) {} }
  presence(except) {
    const n = this.others(except).length;
    for (const w of this.others(except)) this.send(w, { t: 'n', n });
  }

  async webSocketMessage(ws, msg) {
    if (typeof msg !== 'string' || msg.length > 2000000) return;
    let m; try { m = JSON.parse(msg); } catch (e) { return; }
    const list = Array.isArray(m.issues) ? m.issues : [];
    if (m.t === 'hello') {
      const { accepted, acks, seq } = await this.merge(list);
      const all = await this.changedSince(Number(m.since) || 0);
      const n = this.ctx.getWebSockets().length;
      for (let k = 0; k < all.length; k += CHUNK) this.send(ws, { t: 'snap', issues: all.slice(k, k + CHUNK) });
      this.send(ws, { t: 'snap', issues: [], done: 1, seq: (await this.ctx.storage.get('seq')) || seq, a: acks, n, now: Date.now() });
      if (accepted.length) for (const w of this.others(ws)) this.send(w, { t: 'up', issues: accepted, seq, n });
      else for (const w of this.others(ws)) this.send(w, { t: 'n', n });
    } else if (m.t === 'up') {
      const { accepted, back, acks, seq } = await this.merge(list);
      if (accepted.length) for (const w of this.others(ws)) this.send(w, { t: 'up', issues: accepted, seq });
      if (back.length) this.send(ws, { t: 'up', issues: back });
      this.send(ws, { t: 'ack', a: acks, seq });
    }
  }

  async webSocketClose(ws, code) {
    try { ws.close(code, 'bye'); } catch (e) {}
    this.presence(ws);
  }
  async webSocketError(ws) { this.presence(ws); }
}

/* ---------- the lobby: tablets that want to be paired wait here ----------
   Each waiting tablet gets a random 4-digit code (only that tablet and its owner see it).
   Another tablet picks it from the list and types the code. Existing rooms are retained:
   the selected device's room wins, then the joiner's, otherwise a new room is created.
   Nothing is stored: the lobby lives only while tablets are connected. */
const rnd = n => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; };
const code4 = () => String(rnd(10000)).padStart(4, '0');
const rid = () => { const a = new Uint8Array(12); crypto.getRandomValues(a); return [...a].map(b => b.toString(16).padStart(2, '0')).join(''); };
const clean = s => String(s || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 20) || 'Tablet';
const roomOf = x => typeof x === 'string' && /^[a-z0-9_-]{3,40}$/.test(x) ? x : '';
const lightOf = x => {
  if (!x || x.on !== true || typeof x.code !== 'string' || !/^[a-z0-9]{8,24}$/.test(x.code)) return null;
  const map = {};
  for (const colour of ['red', 'yellow', 'blue', 'green']) {
    const ch = x.map && x.map[colour];
    if (!Number.isInteger(ch) || ch < 0 || ch > 6) return null;
    map[colour] = ch;
  }
  return { on: true, code: x.code, map };
};

const FRESH = 40000;   // a tablet that sends heartbeats drops out of the list after this long without one

export class Lobby extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  async fetch() {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }
  send(ws, o) { try { ws.send(JSON.stringify(o)); } catch (e) {} }
  who() {
    const t = Date.now();
    return this.ctx.getWebSockets().map(w => ({ w, a: w.deserializeAttachment() })).filter(x => x.a && x.a.id && (!x.a.hb || t - x.a.seen < FRESH));
  }
  list() { return this.who().map(x => ({ id: x.a.id, name: x.a.name })); }
  broadcast() { const list = this.list(); for (const x of this.who()) this.send(x.w, { t: 'list', list }); }
  /* a finished pairing is remembered for a few minutes, so a tablet whose connection was asleep still hears about it */
  async pendingFor(cid) {
    if (!cid) return null;
    const p = await this.ctx.storage.get('p:' + cid);
    if (!p) return null;
    if (Date.now() - p.at > 300000) { await this.ctx.storage.delete('p:' + cid); return null; }
    return p;
  }

  async webSocketMessage(ws, msg) {
    if (typeof msg !== 'string' || msg.length > 2000) return;
    let m; try { m = JSON.parse(msg); } catch (e) { return; }
    let a = ws.deserializeAttachment();
    if (m.t === 'enter') {
      const cid = String(m.c || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
      if (cid) for (const x of this.ctx.getWebSockets()) {          // one entry per device: the newest window wins
        if (x === ws) continue;
        const b = x.deserializeAttachment();
        if (b && b.cid === cid) { try { x.close(4001, 'replaced'); } catch (e) {} }
      }
      a = { id: rid().slice(0, 10), name: clean(m.name), code: code4(), fails: 0, tries: 0, cid, hb: false, seen: Date.now(), room: roomOf(m.room), light: lightOf(m.light) };
      ws.serializeAttachment(a);
      this.send(ws, { t: 'you', id: a.id, code: a.code });
      for (const [k, v] of await this.ctx.storage.list({ prefix: 'p:' })) if (Date.now() - v.at > 300000) await this.ctx.storage.delete(k);
      const p = await this.pendingFor(cid);
      if (p) this.send(ws, { t: 'paired', room: p.room, peer: p.peer, pv: p.pv, light: p.light });
      this.broadcast();
    } else if (!a) {
      return;
    } else if (m.t === 'hb') {
      a.hb = true; a.seen = Date.now(); ws.serializeAttachment(a);
      const t = Date.now();
      if (this.ctx.getWebSockets().some(w => { const b = w.deserializeAttachment(); return b && b.id && b.hb && t - b.seen >= FRESH; })) this.broadcast();
    } else if (m.t === 'ok') {
      if (a.cid) await this.ctx.storage.delete('p:' + a.cid);
    } else if (m.t === 'name') {
      a.name = clean(m.name); a.seen = Date.now(); ws.serializeAttachment(a); this.broadcast();
    } else if (m.t === 'join') {
      a.seen = Date.now();
      if (++a.tries > 10) { this.send(ws, { t: 'err', e: 'locked' }); ws.serializeAttachment(a); return; }
      ws.serializeAttachment(a);
      const tgt = this.who().find(x => x.a.id === m.target && x.w !== ws);
      if (!tgt) return this.send(ws, { t: 'err', e: 'gone' });
      if (String(m.code) !== tgt.a.code) {
        tgt.a.fails++;
        if (tgt.a.fails >= 5) { tgt.a.fails = 0; tgt.a.code = code4(); this.send(tgt.w, { t: 'you', id: tgt.a.id, code: tgt.a.code }); }
        tgt.w.serializeAttachment(tgt.a);
        return this.send(ws, { t: 'err', e: 'code' });
      }
      // Room and light credentials are shared only after the selected device's PIN is verified.
      // Do not publish either secret in list()/broadcast().
      const room = roomOf(tgt.a.room) || roomOf(a.room) || rid(), at = Date.now();
      const light = lightOf(tgt.a.light) || lightOf(a.light);
      a.room = tgt.a.room = room;
      a.light = tgt.a.light = light;
      ws.serializeAttachment(a); tgt.w.serializeAttachment(tgt.a);
      const pairing = { room, light, pv: 2, at };
      if (tgt.a.cid) await this.ctx.storage.put('p:' + tgt.a.cid, { ...pairing, peer: a.name });
      if (a.cid) await this.ctx.storage.put('p:' + a.cid, { ...pairing, peer: tgt.a.name });
      this.send(tgt.w, { t: 'paired', ...pairing, peer: a.name });
      this.send(ws, { t: 'paired', ...pairing, peer: tgt.a.name });
    }
  }
  async webSocketClose(ws, code) { try { ws.close(code, 'bye'); } catch (e) {} this.broadcast(); }
  async webSocketError() { this.broadcast(); }
}

/* ---------- the light service ----------
   The LED tower is switched by an ESP32 relay board that connects out to this service (it never has to be reachable
   from outside). Tablets tell it what the light should do; it keeps the latest state and hands it to the board the
   moment the board connects. The "light code" in the URL is the shared secret. Nothing about issues is stored here. */
const DEVICE_FRESH = 45000;
export class LightHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  async fetch(req) {
    const dev = new URL(req.url).searchParams.get('d') === '1';
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [dev ? 'dev' : 'app']);
    server.serializeAttachment({ seen: Date.now() });
    const st = await this.ctx.storage.get('st');
    if (dev && st) { try { server.send(JSON.stringify({ t: 'light', ...st })); } catch (e) {} }
    queueMicrotask(() => this.presence());
    return new Response(null, { status: 101, webSocket: client });
  }
  devCount(except) {
    const t = Date.now();
    return this.ctx.getWebSockets('dev').filter(w => w !== except && (w.deserializeAttachment() || {}).seen > t - DEVICE_FRESH).length;
  }
  send(ws, o) { try { ws.send(JSON.stringify(o)); } catch (e) {} }
  presence(except) { const n = this.devCount(except); for (const w of this.ctx.getWebSockets('app')) if (w !== except) this.send(w, { t: 'dev', n }); }
  async webSocketMessage(ws, msg) {
    if (typeof msg !== 'string' || msg.length > 2000) return;
    let m; try { m = JSON.parse(msg); } catch (e) { return; }
    const a = ws.deserializeAttachment() || {}; a.seen = Date.now(); ws.serializeAttachment(a);
    const chans = x => Array.isArray(x) ? x.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 8).slice(0, 8) : [];
    if (m.t === 'hb') { this.send(ws, { t: 'dev', n: this.devCount() }); if (this.ctx.getWebSockets('dev').includes(ws)) this.presence(); }
    else if (m.t === 'set') {
      const st = { a: chans(m.a), b: chans(m.b), m: ['steady', 'flash', 'alt'].includes(m.m) ? m.m : 'steady', ts: Date.now() };
      await this.ctx.storage.put('st', st);
      for (const w of this.ctx.getWebSockets('dev')) this.send(w, { t: 'light', ...st });
      this.send(ws, { t: 'dev', n: this.devCount() });
    } else if (m.t === 'relay') {
      const ch = Number(m.ch); if (!(ch >= 1 && ch <= 8)) return;
      for (const w of this.ctx.getWebSockets('dev')) this.send(w, { t: 'relay', ch, on: m.on !== false, ms: Math.min(Number(m.ms) || 3000, 10000) });
    }
  }
  async webSocketClose(ws, code) { try { ws.close(code, 'bye'); } catch (e) {} this.presence(ws); }
  async webSocketError(ws) { this.presence(ws); }
}
