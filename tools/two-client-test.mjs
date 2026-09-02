// Two-client E2E for Milestone 2 netcode (stories 2.1-2.3).
// Run against a LIVE server on :8080:
//   setsid npm run start --workspace server > /tmp/opencode/m2-server.log 2>&1 < /dev/null &
//   node tools/two-client-test.mjs
// Exits 0 only when every assertion passes.
import WebSocket from 'ws';

const URL = process.env.BB_URL ?? 'ws://localhost:8080';
let failures = 0;

function ok(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
}

function connect(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const queue = [];
    const waiters = [];
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      const i = waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) {
        const [w] = waiters.splice(i, 1);
        w.resolve(msg);
      } else {
        queue.push(msg);
      }
    });
    ws.on('open', () => {
      resolve({
        ws,
        hello: (token) => ws.send(JSON.stringify({ t: 'hello', name, race: 'Aelfon', token })),
        send: (m) => ws.send(JSON.stringify(m)),
        wait: (pred, ms = 2000, label = '') => {
          const qi = queue.findIndex(pred);
          if (qi >= 0) return Promise.resolve(queue.splice(qi, 1)[0]);
          return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error(`timeout waiting for ${label}`)), ms);
            waiters.push({
              pred,
              resolve: (m) => { clearTimeout(timer); res(m); },
            });
          });
        },
        close: () => ws.close(),
      });
    });
    ws.on('error', reject);
  });
}

const run = async () => {
  console.log(`two-client E2E → ${URL}\n`);

  // --- 2.1: hello → welcome → mutual spawn ---
  const A = await connect('Alaric');
  const B = await connect('Brann');
  A.hello();
  B.hello();
  const aW = await A.wait((m) => m.t === 'welcome', 2000, 'A welcome');
  const bW = await B.wait((m) => m.t === 'welcome', 2000, 'B welcome');
  const aSpawnB = await A.wait((m) => m.t === 'spawn' && m.name === 'Brann', 2000, 'A sees B spawn');
  const bSpawnA = await B.wait((m) => m.t === 'spawn' && m.name === 'Alaric', 2000, 'B sees A spawn');
  ok('2.1 hello → welcome (both)', Boolean(aW && bW), `A=${aW?.name} B=${bW?.name}`);
  ok('2.1 A receives spawn of B', Boolean(aSpawnB));
  ok('2.1 B receives spawn of A', Boolean(bSpawnA));

  // --- 2.2: movement broadcast <1s ---
  const t0 = Date.now();
  A.send({
    t: 'movement', seq: 1, ts: Date.now(),
    pos: { x: aW.pos.x, y: aW.pos.y, z: aW.pos.z - 1 },
    yaw: 0, anim: 'walk',
  });
  try {
    const mv = await B.wait((m) => m.t === 'movement' && m.charId === aW.charId, 1000, 'B receives A movement');
    ok('2.2 A→B movement <1s', Date.now() - t0 < 1000 && mv.anim === 'walk', `${Date.now() - t0}ms`);
  } catch {
    ok('2.2 A→B movement <1s', false);
  }

  // --- 2.2: teleport attempt clamped + violation counted ---
  A.send({
    t: 'movement', seq: 2, ts: Date.now(),
    pos: { x: aW.pos.x + 500, y: aW.pos.y, z: aW.pos.z },
    yaw: 0, anim: 'run',
  });
  try {
    const mv2 = await B.wait((m) => m.t === 'movement' && m.charId === aW.charId
      && Math.abs(m.pos.x - aW.pos.x) > 1, 1000, 'clamped movement broadcast');
    ok('2.2 speedhack move clamped (server-corrected pos broadcast)',
      Math.abs(mv2.pos.x - aW.pos.x) < 10, `dx=${(mv2.pos.x - aW.pos.x).toFixed(2)}`);
  } catch {
    ok('2.2 speedhack move clamped (server-corrected pos broadcast)', false);
  }

  // --- 2.3: chat sanitized (XSS payload) ---
  A.send({ t: 'chat', channel: 'local', text: 'hello <b onload=alert(1)>' });
  try {
    const ch = await B.wait((m) => m.t === 'chat' && m.from === 'Alaric', 2000, 'B receives chat');
    ok('2.3 chat arrives sanitized (no raw tag)',
      !ch.text.includes('<b onload=alert(1>') && !ch.text.includes('<b '), JSON.stringify(ch.text));
    ok('2.3 chat escaped on wire', ch.text.includes('&lt;'), JSON.stringify(ch.text));
  } catch {
    ok('2.3 chat arrives sanitized (no raw tag)', false);
    ok('2.3 chat escaped on wire', false);
  }

  // --- 2.3: emote broadcast ---
  A.send({ t: 'emote', emote: 'wave' });
  try {
    const em = await B.wait((m) => m.t === 'emote' && m.emote === 'wave', 2000, 'B receives emote');
    ok('2.3 emote broadcast', Boolean(em));
  } catch {
    ok('2.3 emote broadcast', false);
  }

  // --- 2.3: party invite → accept → party broadcast ---
  A.send({ t: 'party', action: 'invite', who: 'Brann' });
  try {
    await B.wait((m) => m.t === 'partyInvite' && m.from === 'Alaric', 2000, 'B invite toast');
    B.send({ t: 'party', action: 'accept' });
    const aP = await A.wait((m) => m.t === 'party' && Array.isArray(m.members)
      && m.members.includes('Alaric') && m.members.includes('Brann'), 2000, 'A party broadcast');
    const bP = await B.wait((m) => m.t === 'party' && Array.isArray(m.members)
      && m.members.includes('Alaric') && m.members.includes('Brann'), 2000, 'B party broadcast');
    ok('2.3 invite → accept → party broadcast to both', Boolean(aP && bP), JSON.stringify(aP?.members));
  } catch (e) {
    ok('2.3 invite → accept → party broadcast to both', false, e.message);
  }

  // --- 2.3: party chat routed to members only ---
  A.send({ t: 'chat', channel: 'party', text: 'party check' });
  try {
    const pc = await B.wait((m) => m.t === 'chat' && m.channel === 'party' && m.from === 'Alaric', 2000, 'B party chat');
    ok('2.3 party chat routed to member', pc.text === 'party check', JSON.stringify(pc.text));
  } catch {
    ok('2.3 party chat routed to member', false);
  }

  // --- /healthz: chars + violations counters ---
  try {
    const httpUrl = URL.replace(/^ws/, 'http');
    const h = await fetch(`${httpUrl}/healthz`).then((r) => r.json());
    ok('healthz {chars, violations}',
      typeof h.chars === 'number' && h.chars >= 2 && typeof h.violations === 'number' && h.violations >= 1,
      JSON.stringify(h));
  } catch (e) {
    ok('healthz {chars, violations}', false, e.message);
  }

  A.close();
  B.close();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
};

run().catch((e) => {
  console.error('E2E ERROR:', e.message);
  process.exit(1);
});
