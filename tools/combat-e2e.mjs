// Combat E2E for Milestone 3 (stories 3.1-3.2).
// Run against a LIVE server:
//   cd server && PORT=9080 setsid node src/index.ts > /tmp/opencode/m3-server.log 2>&1 < /dev/null &
//   BB_URL=ws://localhost:9080 node tools/combat-e2e.mjs
// Exits 0 only when every assertion passes.
import WebSocket from 'ws';

const URL = process.env.BB_URL ?? 'ws://localhost:9080';
let failures = 0;

function ok(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const queue = [];
    const waiters = [];
    const all = [];
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      all.push(msg);
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
        all,
        hello: (token) => ws.send(JSON.stringify({ t: 'hello', name, race: 'Aelfon', token })),
        send: (m) => ws.send(JSON.stringify(m)),
        wait: (pred, ms = 3000, label = '') => {
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

// Walk toward a target point in clamp-sized steps (server clamps 4.8m/msg).
async function walkTo(c, tx, tz, y = 2.2) {
  let x = 4, z = -12; // spawn ring
  let seq = 0;
  for (let step = 0; step < 40; step++) {
    const dx = tx - x, dz = tz - z;
    const d = Math.hypot(dx, dz);
    if (d < 0.6) break;
    const stepLen = Math.min(4.2, d);
    x += (dx / d) * stepLen;
    z += (dz / d) * stepLen;
    c.send({ t: 'movement', seq: seq++, ts: Date.now(), pos: { x, y, z }, yaw: Math.atan2(dx, dz), anim: 'run' });
    await sleep(120);
  }
}

const healthz = async (port = 9080) => {
  const res = await fetch(`http://localhost:${port}/healthz`);
  return res.json();
};

const run = async () => {
  console.log(`combat E2E → ${URL}\n`);

  // --- 3.2 backfill: mobs + dummy visible on spawn ---
  const A = await connect('Runeblade');
  A.hello();
  const welcome = await A.wait((m) => m.t === 'welcome', 4000, 'welcome');
  ok('welcome received', typeof welcome.charId === 'string');
  const myId = welcome.charId;

  const mobSpawn = await A.wait((m) => m.t === 'mobSpawn' && m.mobType === 'glimmerling', 4000, 'glimmerling mobSpawn');
  ok('mob backfill: glimmerling spawned', typeof mobSpawn.mobId === 'string', mobSpawn.mobId);
  const glimId = mobSpawn.mobId;
  const drone = A.all.find((m) => m.t === 'mobSpawn' && m.mobType === 'warden-drone');
  ok('mob backfill: warden drone visible', Boolean(drone));
  const dummySpawn = A.all.find((m) => m.t === 'mobSpawn' && m.mobType === 'dummy');
  ok('training dummy spawned', Boolean(dummySpawn));

  // --- 3.2 aggro: walk to the glimmerling, expect telegraph + damage ---
  await walkTo(A, 12, -24);
  const telegraph = await A.wait((m) => m.t === 'mobTelegraph' && m.mobId === glimId, 5000, 'telegraph');
  ok('mob aggro → telegraph received', typeof telegraph.ms === 'number' && telegraph.ms >= 500, `${telegraph.ms}ms windup`);

  const mobHit = await A.wait((m) => m.t === 'combat' && m.kind === 'hit' && m.mobId === glimId && m.target === myId, 6000, 'mob hit');
  ok('mob windup → damage received', typeof mobHit.amount === 'number' && mobHit.amount > 0, `${mobHit.amount} dmg`);
  const hpDrop = await A.wait((m) => m.t === 'hp' && m.charId === myId && m.hp < m.maxHp, 3000, 'hp drop');
  ok('HP authoritative update received', hpDrop.hp < hpDrop.maxHp, `${hpDrop.hp}/${hpDrop.maxHp}`);

  // --- 3.1 attack combo: kill the glimmerling with staged swings ---
  const swingPromises = [
    A.wait((m) => m.t === 'combat' && m.kind === 'hit' && m.charId === myId && m.target === glimId, 1500, 'own hit'),
    A.wait((m) => m.t === 'combat' && m.kind === 'hit' && m.charId === myId && m.target === glimId, 2500, 'own hit 2'),
  ];
  A.send({ t: 'combat', kind: 'attack', target: glimId });
  const firstHit = await swingPromises[0];
  ok('attack intent → server hit event (stage damage)', typeof firstHit.amount === 'number' && firstHit.amount >= 12, `${firstHit.amount} dmg${firstHit.crit ? ' CRIT' : ''}`);
  await sleep(500);
  A.send({ t: 'combat', kind: 'attack', target: glimId });
  await swingPromises[1];
  await sleep(500);
  A.send({ t: 'combat', kind: 'attack', target: glimId }); // 12+14+20 ≥ 30 → dies
  const death = await A.wait((m) => m.t === 'combat' && m.kind === 'death' && m.mobId === glimId, 4000, 'mob death');
  ok('glimmerling killed (server death event)', death.mobId === glimId);
  const xp = await A.wait((m) => m.t === 'xp' && m.amount > 0, 3000, 'xp award');
  ok('XP awarded to top-damage char', xp.amount === 25, `+${xp.amount} XP (total ${xp.total})`);

  // --- 3.1 dodge: i-frames intent accepted server-side ---
  A.send({ t: 'combat', kind: 'dodge' });
  const dodgeEv = await A.wait((m) => m.t === 'combat' && m.kind === 'dodge' && (m.charId === myId || m.target === myId), 2000, 'dodge event');
  ok('dodge intent accepted (event broadcast)', Boolean(dodgeEv));

  // --- 3.2 training dummy: hits → DPS log event ---
  await walkTo(A, 9, -6);
  A.send({ t: 'combat', kind: 'attack', target: 'dummy-0' });
  await sleep(600);
  A.send({ t: 'combat', kind: 'attack', target: 'dummy-0' });
  const dps = await A.wait((m) => m.t === 'combat' && m.kind === 'dps' && m.mobId === 'dummy-0', 4000, 'dps log');
  ok('dummy DPS log event on hit', typeof dps.amount === 'number' && dps.amount > 0, `${dps.amount} dps`);

  // --- 3.1 anti-cheat: fabricated damage is REJECTED (no state change) ---
  const violationsBefore = (await healthz()).violations;
  const B = await connect('Shade');
  B.hello();
  await B.wait((m) => m.t === 'welcome', 4000, 'B welcome');
  const bId = B.all.find((m) => m.t === 'welcome').charId;
  const bHpBefore = B.all.filter((m) => m.t === 'hp' && m.charId === bId).at(-1)?.hp ?? 100;

  // modified client: damage-kind combat frame + amount-bearing attack frame
  B.send({ t: 'combat', kind: 'damage', amount: 9999, target: myId });
  B.send({ t: 'combat', kind: 'attack', amount: 9999, target: myId });
  B.send({ t: 'combat', kind: 'attack', amount: 500, hp: 1, crit: true, target: bId });
  await sleep(1200);

  const hz = await healthz();
  ok('fabricated damage → counted as violations', hz.violations > violationsBefore, `${violationsBefore} → ${hz.violations}`);
  const bHpMsgs = B.all.filter((m) => m.t === 'hp' && m.charId === bId);
  const bHpAfter = bHpMsgs.at(-1)?.hp ?? 100;
  ok('fabricated damage → victim HP unchanged', bHpAfter === bHpBefore, `${bHpBefore} → ${bHpAfter}`);
  const giant = A.all.some((m) => m.t === 'combat' && m.kind === 'hit' && m.amount >= 100);
  ok('no huge/fabricated damage ever broadcast', !giant);

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  A.close(); B.close();
  process.exit(failures === 0 ? 0 : 1);
};

run().catch((e) => {
  console.error('E2E ERROR:', e.message);
  process.exit(1);
});
