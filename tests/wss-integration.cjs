// Protocol-level interoperability checks against a fresh OSS test server.
// npm install --no-save ws; HBBS_WS=ws://127.0.0.1:24118 HBBR_WS=ws://127.0.0.1:24119
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const WS = require(process.env.WS_MODULE || 'ws');
const base = process.env.HBBS_WS || 'ws://127.0.0.1:24118';
const relay = process.env.HBBR_WS || 'ws://127.0.0.1:24119';
const key = process.env.SERVER_PUBLIC_KEY;
assert(key, 'SERVER_PUBLIC_KEY required');
const sockets = [];
const pause = ms => new Promise(r => setTimeout(r, ms));
function varint(n) { const b = []; do { b.push((n & 127) | (n > 127 ? 128 : 0)); n >>>= 7; } while (n); return Buffer.from(b); }
function num(n, v) { return Buffer.concat([varint(n * 8), varint(v)]); }
function field(n, v) { const b = Buffer.from(v); return Buffer.concat([varint(n * 8 + 2), varint(b.length), b]); }
function fields(b) {
  let p = 0; const m = new Map();
  const read = () => { let n = 0, s = 0, v; do { assert(p < b.length); v = b[p++]; n += (v & 127) * 2 ** s; s += 7; assert(s < 49); } while (v & 128); return n; };
  while (p < b.length) { const tag = read(), n = tag >>> 3, wire = tag & 7; if (wire === 0) m.set(n, read()); else { assert.equal(wire, 2); const len = read(); m.set(n, b.subarray(p, p + len)); p += len; } }
  return m;
}
function identity(id) { return { id, uuid: crypto.randomBytes(16), pk: crypto.randomBytes(32) }; }
function pk(i) { return field(15, Buffer.concat([field(1, i.id), field(2, i.uuid), field(3, i.pk)])); }
async function open(url = base, options = {}) {
  const ws = new WS(url, { handshakeTimeout: 5000, rejectUnauthorized: process.env.INSECURE_TEST !== '1', ...options }); sockets.push(ws);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const queue = [], waiters = [];
  const client = { ws, beats: 0, closed: false, send: b => ws.send(b),
    next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve, reject) => {
      const entry = { resolve, reject }; entry.timer = setTimeout(() => { const i = waiters.indexOf(entry); if (i >= 0) waiters.splice(i, 1); reject(Error('protocol response timeout')); }, 5000); waiters.push(entry);
    }) };
  ws.on('message', b => { if (!b.length) { client.beats++; ws.send(b); return; } const waiter = waiters.shift(); if (waiter) { clearTimeout(waiter.timer); waiter.resolve(b); } else queue.push(b); });
  ws.on('close', () => { client.closed = true; });
  return client;
}
async function register(client, i, expected = 0) {
  client.send(pk(i)); const response = fields(await client.next()); assert(response.has(16));
  assert.equal(fields(response.get(16)).get(1) || 0, expected); return response;
}
async function relayRoundTrip() {
  const a = await open(relay), b = await open(relay), uuid = crypto.randomUUID();
  const request = field(18, Buffer.concat([field(2, uuid), field(6, key)]));
  a.send(request); await pause(100); b.send(request); await pause(200);
  a.send(Buffer.from('forward')); assert.equal((await b.next()).toString(), 'forward');
  b.send(Buffer.from('reverse')); assert.equal((await a.next()).toString(), 'reverse');
  a.ws.close(); b.ws.close();
  const bad = await open(relay); bad.send(field(18, Buffer.concat([field(2, crypto.randomUUID()), field(6, 'wrong-key')])));
  await pause(500); assert(bad.closed, 'invalid relay key must be rejected');
}
(async () => {
  const seed = `${Date.now()}`.slice(-8);
  const alice = identity(`71${seed}`), bob = identity(`72${seed}`);
  const a = await open(), b = await open();
  await register(a, alice); await register(b, bob);
  console.log('PASS two independent WS registrations behind the same IP');
  const bad = await open(); await register(bad, { ...alice, uuid: crypto.randomBytes(16) }, 2); bad.ws.close();
  const invalid = await open(); await register(invalid, { ...bob, id: 'x' }, 5); invalid.ws.close();
  console.log('PASS duplicate ID with wrong UUID rejected; malformed identity rejected');
  // Route an initiating client's PunchHoleRequest to the registered target.
  const caller = await open();
  caller.send(field(8, Buffer.concat([field(1, alice.id), field(3, key), field(6, '1.4.4')])));
  const punch = fields(await a.next()); assert(punch.has(9));
  const ph = fields(punch.get(9)); assert.equal(ph.get(3), 2, 'WS target must use relay');
  const response = await open();
  response.send(field(19, Buffer.concat([field(1, ph.get(1)), field(2, 'test-uuid'), field(3, 'rast.neithos.ru:443'), field(4, alice.id), field(7, '1.4.4')])));
  const rr = fields(await caller.next()); assert(rr.has(19)); assert(fields(rr.get(19)).get(5).length > 32, 'signed target key returned');
  console.log('PASS incoming connection notification and signed-key reply over WS');
  caller.ws.close(); response.ws.close();
  const attacker = await open(); attacker.send(field(8, Buffer.concat([field(1, alice.id), field(3, 'wrong-key')])));
  const rejected = fields(await attacker.next()); assert.equal(fields(rejected.get(11)).get(3), 3); attacker.ws.close();
  console.log('PASS wrong rendezvous key rejected');
  const replacement = await open(); await register(replacement, alice);
  a.ws.close(); await pause(200);
  const caller2 = await open(); caller2.send(field(18, Buffer.concat([field(1, alice.id), field(2, 'route-after-reconnect')])));
  assert(fields(await replacement.next()).has(18)); caller2.ws.close();
  console.log('PASS reconnect survives old session cleanup');
  const online = await open();
  online.send(field(23, Buffer.concat([field(2, alice.id), field(2, bob.id)])));
  assert.equal(fields(fields(await online.next()).get(24)).get(1)[0], 0xc0);
  online.ws.close();
  console.log('PASS online status lookup over WS');
  // Keep open beyond the original OSS 30-second deadline.
  await pause(Number(process.env.HEARTBEAT_WAIT_MS || 35000));
  assert(!replacement.closed && !b.closed); assert(replacement.beats >= 3 && b.beats >= 3);
  console.log('PASS persistent registration and bidirectional heartbeat beyond 30 seconds');
  await relayRoundTrip(); console.log('PASS bidirectional relay and key enforcement');
  if (process.env.HBBS_UDP_PORT) {
    const sock = dgram.createSocket('udp4');
    const udp = identity(`73${seed}`);
    const got = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('UDP timeout')), 4000); sock.once('message', b => { clearTimeout(timer); resolve(b); }); });
    sock.send(pk(udp), Number(process.env.HBBS_UDP_PORT), process.env.HBBS_UDP_HOST || '127.0.0.1');
    try { const r = fields(await got); assert.equal(fields(r.get(16)).get(1) || 0, 0); } finally { sock.close(); }
    console.log('PASS existing UDP registration');
  }
})().then(() => { for (const w of sockets) w.terminate(); }).catch(e => { console.error(e.stack); for (const w of sockets) w.terminate(); process.exitCode = 1; });
