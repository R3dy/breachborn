// Game server: ws transport + HTTP /healthz on :8080.
// All world/social/combat logic lives in pure modules (auth.ts, world.ts,
// social.ts, combat.ts, mobs.ts); this file only routes protocol frames
// and maps pure results onto wire messages (CONVENTIONS.md).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { COMBAT, DUMMY, type ClientMsg, type ServerMsg } from '@breachborn/shared';
import { World, AOI_RADIUS, type Char } from './world.ts';
import { Social, isEmote, sanitizeChat } from './social.ts';
import { issueToken, verifyToken, newCharId, validateName, fallbackName, dedupeName, escapeHtml, sanitizeName } from './auth.ts';
import { Combat, swing, validateCombatIntent, type Fighter } from './combat.ts';
import { Mobs, Dummy, type Mob, type MobEvent } from './mobs.ts';

type HelloMsg = Extract<ClientMsg, { t: 'hello' }>;
type ChatMsg = Extract<ClientMsg, { t: 'chat' }>;
type PartyMsg = Extract<ClientMsg, { t: 'party' }>;
type CombatMsg = Extract<ClientMsg, { t: 'combat' }>;

const PORT = Number(process.env.PORT ?? 8080);
const world = new World();
const social = new Social();
const combat = new Combat();
const mobs = new Mobs(combat.ledger); // shared kill-credit ledger (top-damage wins)
const dummy = new Dummy();
const byChar = new Map<string, WebSocket>();

// Deterministic crit roll hook (swap for a seeded rng in tests).
const rng: () => number = Math.random;

const http = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      chars: world.chars.size,
      violations: world.violations,
      mobs: mobs.mobs.size,
      mobsAlive: [...mobs.mobs.values()].filter((m) => m.alive).length,
    }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: http });

function sendTo(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function sendToChar(charId: string, msg: ServerMsg): void {
  const ws = byChar.get(charId);
  if (ws) sendTo(ws, msg);
}

// AOI broadcast: everyone within view radius of `charId`.
function broadcastAoi(charId: string, msg: ServerMsg, includeSelf = false): void {
  for (const other of world.othersInAoi(charId)) sendToChar(other.charId, msg);
  if (includeSelf) sendToChar(charId, msg);
}

// AOI broadcast anchored on a world position (mobs/dummy aren't chars).
function broadcastAtPos(pos: { x: number; z: number }, msg: ServerMsg): void {
  for (const c of world.charsInRange({ x: pos.x, y: 0, z: pos.z }, AOI_RADIUS)) sendToChar(c.charId, msg);
}

wss.on('connection', (ws: WebSocket) => {
  let charId: string | null = null;

  ws.on('message', (raw: RawData) => {
    let msg: ClientMsg;
    try { msg = JSON.parse(String(raw)) as ClientMsg; } catch { return; }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;

    if (msg.t === 'ping') {
      const char = charId ? world.chars.get(charId) : undefined;
      const reply: ServerMsg = { t: 'pong', ts: typeof msg.ts === 'number' ? msg.ts : 0 };
      if (char) reply.pos = char.pos; // client-side reconciliation hook
      sendTo(ws, reply);
      return;
    }

    if (msg.t === 'hello') {
      handleHello(ws, msg, (id) => { charId = id; });
      return;
    }

    if (!charId) return; // every frame except ping/hello requires an identity
    const char = world.chars.get(charId);
    if (!char) return;

    switch (msg.t) {
      case 'movement': {
        // Dead souls don't move — the spire decides when they walk again.
        const f0 = combat.fighterOf(charId);
        if (f0 && !f0.alive) return;
        // Client sends at 10Hz; server validates then forwards at the same
        // cadence (within the 10-20Hz budget). Clamped moves broadcast the
        // server-corrected position so the world stays continuous.
        const verdict = world.applyMovement(char, msg.pos, msg.yaw, msg.anim, Date.now());
        if (verdict !== 'rejected') {
          combat.syncPos(charId, char.pos, char.yaw);
          broadcastAoi(charId, {
            t: 'movement', charId,
            pos: char.pos, yaw: char.yaw, anim: char.anim,
          });
        }
        return;
      }
      case 'combat':
        onCombatIntent(char, msg);
        return;
      case 'quest':
      case 'terminal':
        return; // arrives in M4+
      case 'chat':
        onChat(char, msg);
        return;
      case 'emote':
        if (isEmote(msg.emote)) {
          broadcastAoi(charId, { t: 'emote', charId, emote: msg.emote }, true);
        }
        return;
      case 'party':
        onParty(char, msg);
        return;
    }
  });

  ws.on('close', () => {
    if (!charId) return;
    if (byChar.get(charId) !== ws) return; // a newer connection replaced this one
    byChar.delete(charId);
    combat.leave(charId);
    const left = world.disconnect(charId, Date.now());
    if (left) {
      broadcastAoi(left.charId, { t: 'despawn', charId: left.charId });
      if (left.partyId) {
        const res = social.leave(left);
        if (res.ok) broadcastParty(res.memberIds);
      }
    }
  });

  ws.on('error', () => ws.close());
});

// hello → token/registry resolution → welcome + spawn fan-out.
function handleHello(ws: WebSocket, msg: HelloMsg, setCharId: (id: string) => void): void {
  const now = Date.now();

  // Token → character resolution (valid token restores identity; invalid is
  // treated as no token — hard tamper handling is story 7.3).
  let regCharId: string | undefined;
  if (typeof msg.token === 'string' && msg.token.length > 0) {
    const payload = verifyToken(msg.token, now);
    if (payload && world.registry.has(payload.charId)) regCharId = payload.charId;
  }

  const charId2 = regCharId ?? newCharId();

  // Name: returning chars keep their registry name; fresh guests validate +
  // dedupe (deterministic #NNNN) or fall back to wraith-XXXX.
  let name: string;
  const rec = regCharId ? world.registry.get(regCharId) : undefined;
  if (rec) {
    name = rec.name;
  } else {
    const base = validateName(String(msg.name ?? '')) ?? fallbackName();
    const taken = new Set<string>();
    for (const c of world.chars.values()) taken.add(c.name);
    name = dedupeName(base, taken);
  }
  const race = escapeHtml(sanitizeName(String(msg.race ?? ''))) || 'Aelfon';

  // Same character reconnecting while a stale socket lingers → replace it.
  const old = byChar.get(charId2);
  if (old && old !== ws) old.close();

  const { char } = world.join({ charId: charId2, name, race, now, restore: regCharId !== undefined });
  combat.join(char.charId, char.pos, now);
  byChar.set(char.charId, ws);
  setCharId(char.charId);

  sendTo(ws, {
    t: 'welcome',
    charId: char.charId,
    name: char.name,
    level: char.level,
    xp: char.xp,
    pos: char.pos,
    token: issueToken(char.charId, now),
    roster: world.rosterFor(char.charId),
  });
  sendTo(ws, { t: 'hp', charId: char.charId, hp: combat.fighterOf(char.charId)!.hp, maxHp: combat.fighterOf(char.charId)!.maxHp });
  // Backfill: spawn frames for everyone already visible to the joiner.
  for (const other of world.othersInAoi(char.charId)) {
    sendTo(ws, { t: 'spawn', charId: other.charId, name: other.name, pos: other.pos });
  }
  // Backfill: mobs + dummy within view radius (story 3.2).
  for (const mob of mobs.mobs.values()) {
    if (distTo(char.pos, mob.pos) <= AOI_RADIUS) {
      sendTo(ws, {
        t: 'mobSpawn', mobId: mob.id, mobType: mob.type, name: mob.stats.name,
        pos: mob.pos, hp: mob.hp, maxHp: mob.maxHp,
      });
    }
  }
  if (distTo(char.pos, dummy.pos) <= AOI_RADIUS) {
    sendTo(ws, { t: 'mobSpawn', mobId: dummy.id, mobType: 'dummy', name: 'Training Dummy', pos: dummy.pos, hp: 1, maxHp: 1 });
  }
  // Announce the joiner to everyone who can see them.
  broadcastAoi(char.charId, { t: 'spawn', charId: char.charId, name: char.name, pos: char.pos });
}

function distTo(a: { x: number; z: number }, b: { x: number; z: number }): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

// Chat: rate-limited, sanitized; local → AOI, party → members only.
function onChat(char: Char, msg: ChatMsg): void {
  const now = Date.now();
  if (!social.allowChat(char.charId, now)) {
    sendToChar(char.charId, {
      t: 'error', code: 'throttled',
      message: 'the Weave dampens your voice — a breath, then speak',
    });
    return;
  }
  const text = sanitizeChat(String(msg.text ?? ''));
  if (!text) return;
  if (msg.channel === 'party') {
    if (!char.partyId) {
      sendToChar(char.charId, {
        t: 'error', code: 'no-party',
        message: 'you have no party — /party invite <name> first',
      });
      return;
    }
    for (const id of social.memberIdsOf(char.partyId)) {
      if (id !== char.charId) {
        sendToChar(id, { t: 'chat', from: char.name, channel: 'party', text });
      }
    }
    return;
  }
  broadcastAoi(char.charId, { t: 'chat', from: char.name, channel: 'local', text });
}

// Party: invite (by name) → partyInvite toast; accept → party broadcast.
function onParty(char: Char, msg: PartyMsg): void {
  if (msg.action === 'invite') {
    const who = typeof msg.who === 'string' ? msg.who : '';
    const target = world.byName(who);
    if (!target) {
      sendToChar(char.charId, {
        t: 'error', code: 'no-such-soul',
        message: 'no soul by that name on this shard',
      });
      return;
    }
    const res = social.stageInvite(char, target);
    if (!res.ok) {
      sendToChar(char.charId, { t: 'error', code: res.code, message: res.message });
      return;
    }
    sendToChar(target.charId, { t: 'partyInvite', from: char.name });
    return;
  }
  if (msg.action === 'accept') {
    const res = social.acceptInvite(char, (id) => world.chars.get(id));
    if (!res.ok) {
      sendToChar(char.charId, { t: 'error', code: res.code, message: res.message });
      return;
    }
    broadcastParty(res.memberIds);
    return;
  }
  if (msg.action === 'leave') {
    const res = social.leave(char);
    if (!res.ok) {
      sendToChar(char.charId, { t: 'error', code: res.code, message: res.message });
      return;
    }
    sendToChar(char.charId, { t: 'party', members: [] });
    broadcastParty(res.memberIds);
  }
}

// Push the member-name list to every (remaining) member.
function broadcastParty(memberIds: string[]): void {
  const members: string[] = [];
  for (const id of memberIds) {
    const c = world.chars.get(id);
    if (c) members.push(c.name);
  }
  for (const id of memberIds) sendToChar(id, { t: 'party', members });
}

// ---- Combat (story 3.1/3.2) — server-authoritative ----
// Client frames are INTENTS ONLY. validateCombatIntent is the anti-cheat seam:
// fabricated kinds ('damage') or damage-shaped fields (amount/hp/crit) are
// dropped + counted as violations, with zero state change.

function onCombatIntent(char: Char, msg: CombatMsg): void {
  const now = Date.now();
  const intent = validateCombatIntent(msg);
  if (!intent) {
    world.violations++;
    return;
  }
  const attacker = combat.fighterOf(char.charId);
  if (!attacker) return;

  if (intent.t === 'dodge') {
    const res = combat.startDodge(attacker, now);
    if (res.ok) broadcastAoi(char.charId, { t: 'combat', charId: char.charId, kind: 'dodge' }, true);
    return;
  }
  if (intent.t === 'cast') return; // sigilcraft stub — Q4 wires the cast engine

  // attack intent. Targets: another fighter, a mob, or the training dummy.
  const target = intent.target;
  if (!target || target === char.charId) {
    // whiff — still animate so client/server stay consistent (empty-hand AC)
    broadcastAoi(char.charId, {
      t: 'combat', charId: char.charId, kind: 'attack', stage: attacker.comboStage,
    }, true);
    return;
  }
  if (target === dummy.id) {
    resolveDummyAttack(char, attacker, now);
    return;
  }
  const mob = mobs.mobOf(target);
  if (mob) {
    resolveMobAttack(char, attacker, mob, now);
    return;
  }
  resolveFighterAttack(char, attacker, target, now);
}

function resolveMobAttack(char: Char, attacker: Fighter, mob: Mob, now: number): void {
  if (!attacker.alive) return;
  const s = swing(attacker, mobs.asTarget(mob), now, rng);
  if (!s.ok) {
    if (s.error === 'out-of-range' || s.error === 'no-target' || s.error === 'target-dead') {
      // whiff — animate for consistency, deal nothing
      broadcastAoi(char.charId, { t: 'combat', charId: char.charId, kind: 'attack', stage: attacker.comboStage }, true);
    }
    return; // on-cooldown / self-dead: silent, no state change
  }
  broadcastAoi(char.charId, { t: 'combat', charId: char.charId, kind: 'attack', stage: s.stage }, true);
  if (s.amount <= 0) return;
  const res = mobs.applyDamage(mob.id, char.charId, s.amount, now);
  if (res.died) {
    broadcastAtPos(mob.pos, { t: 'combat', mobId: mob.id, kind: 'death' });
    if (res.killerId) {
      const total = world.addXp(res.killerId, res.xp);
      sendToChar(res.killerId, { t: 'xp', amount: res.xp, total });
    }
  } else {
    broadcastAoi(char.charId, {
      t: 'combat', charId: char.charId, kind: 'hit',
      amount: res.applied, crit: s.crit, target: mob.id,
    }, true);
  }
}

function resolveFighterAttack(char: Char, attacker: Fighter, targetId: string, now: number): void {
  const s = combat.resolveFighterAttack(attacker, targetId, now, rng);
  if (!s.ok) {
    if (s.error === 'out-of-range' || s.error === 'no-target' || s.error === 'target-dead') {
      broadcastAoi(char.charId, { t: 'combat', charId: char.charId, kind: 'attack', stage: attacker.comboStage }, true);
    }
    return;
  }
  broadcastAoi(char.charId, { t: 'combat', charId: char.charId, kind: 'attack', stage: s.stage }, true);
  const victim = combat.fighterOf(targetId);
  if (!victim) return;
  if (s.dodged) {
    broadcastAoi(char.charId, { t: 'combat', charId: char.charId, kind: 'dodge', target: victim.id }, true);
    return;
  }
  broadcastAoi(char.charId, {
    t: 'combat', charId: char.charId, kind: 'hit',
    amount: s.amount, crit: s.crit, target: victim.id,
  }, true);
  sendToChar(victim.id, { t: 'hp', charId: victim.id, hp: victim.hp, maxHp: victim.maxHp });
  if (!victim.alive) {
    broadcastAoi(victim.id, { t: 'combat', charId: victim.id, kind: 'death' });
    sendToChar(victim.id, { t: 'death', respawnInMs: COMBAT.DEATH_RESPAWN_MS });
  }
}

// Training dummy: infinite HP, records rolling DPS per attacker, responds
// with a DPS log event. Resets when the last attacker leaves 10m (tick loop).
function resolveDummyAttack(char: Char, attacker: Fighter, now: number): void {
  const s = swing(attacker, dummy.asTarget(), now, rng);
  if (!s.ok) {
    if (s.error === 'out-of-range' || s.error === 'target-dead' || s.error === 'no-target') {
      broadcastAoi(char.charId, { t: 'combat', charId: char.charId, kind: 'attack', stage: attacker.comboStage }, true);
    }
    return;
  }
  broadcastAoi(char.charId, { t: 'combat', charId: char.charId, kind: 'attack', stage: s.stage, target: dummy.id }, true);
  if (s.amount <= 0) return;
  dummy.recordHit(char.charId, s.amount, now);
  const dps = dummy.dpsFor(char.charId, now);
  broadcastAtPos(dummy.pos, {
    t: 'combat', mobId: dummy.id, kind: 'dps', amount: Math.round(dps * 10) / 10, target: char.charId,
  });
}

// ---- Server tick (10Hz): mob AI, respawns, mob movement fan-out ----

const TICK_MS = 100;
const MOB_BROADCAST_MIN_STEP = 0.12; // don't rebroadcast idle mobs every tick
const lastMobBroadcast = new Map<string, { x: number; z: number; state: string }>();

function playersInView(): { id: string; pos: { x: number; y: number; z: number }; alive: boolean }[] {
  const out: { id: string; pos: { x: number; y: number; z: number }; alive: boolean }[] = [];
  for (const c of world.chars.values()) {
    const f = combat.fighterOf(c.charId);
    out.push({ id: c.charId, pos: c.pos, alive: f ? f.alive : false });
  }
  return out;
}

function onMobEvent(ev: MobEvent, mobPos: { x: number; z: number }): void {
  if (ev.kind === 'telegraph') {
    broadcastAtPos(mobPos, { t: 'mobTelegraph', mobId: ev.mobId, ms: ev.ms });
    return;
  }
  if (ev.kind === 'hit') {
    const res = combat.damageChar(ev.targetId, ev.amount, Date.now());
    if (!res) return;
    if (res.dodged) {
      broadcastAtPos(mobPos, { t: 'combat', mobId: ev.mobId, kind: 'dodge', target: ev.targetId });
      return;
    }
    const victim = combat.fighterOf(ev.targetId);
    broadcastAtPos(mobPos, {
      t: 'combat', mobId: ev.mobId, kind: 'hit',
      amount: res.applied, target: ev.targetId,
    });
    if (victim) sendToChar(victim.id, { t: 'hp', charId: victim.id, hp: victim.hp, maxHp: victim.maxHp });
    if (res.killed) {
      broadcastAoi(ev.targetId, { t: 'combat', charId: ev.targetId, kind: 'death' });
      sendToChar(ev.targetId, { t: 'death', respawnInMs: COMBAT.DEATH_RESPAWN_MS });
    }
    return;
  }
  if (ev.kind === 'death') {
    // Mob died in the AI loop — kill credit already assigned at damage time.
    broadcastAtPos(mobPos, { t: 'combat', mobId: ev.mobId, kind: 'death' });
    if (ev.killerId) {
      const total = world.addXp(ev.killerId, ev.xp);
      sendToChar(ev.killerId, { t: 'xp', amount: ev.xp, total });
    }
    return;
  }
  if (ev.kind === 'respawn') {
    const mob = mobs.mobOf(ev.mobId);
    if (mob) {
      lastMobBroadcast.delete(ev.mobId);
      broadcastAtPos(mob.home, {
        t: 'mobSpawn', mobId: mob.id, mobType: mob.type, name: mob.stats.name,
        pos: mob.pos, hp: mob.hp, maxHp: mob.maxHp,
      });
    }
  }
}

setInterval(() => {
  const now = Date.now();

  // Player respawns: dead fighters past their timer → spire base + drift debuff.
  for (const r of combat.tick(now)) {
    const char = world.chars.get(r.id);
    if (char) {
      char.pos = { ...r.pos };
      char.anim = 'idle';
    }
    sendToChar(r.id, { t: 'respawn', pos: r.pos });
    sendToChar(r.id, { t: 'hp', charId: r.id, hp: r.hp, maxHp: r.maxHp });
    sendToChar(r.id, {
      t: 'chat', from: 'the Weave', channel: 'local',
      text: `the unlogged drift clings to you for ${COMBAT.DRIFT_DEBUFF_MS / 1000}s`,
    });
    broadcastAoi(r.id, { t: 'combat', charId: r.id, kind: 'respawn' });
    broadcastAoi(r.id, { t: 'movement', charId: r.id, pos: r.pos, yaw: 0, anim: 'idle' });
  }

  // Mob AI.
  const players = playersInView();
  for (const ev of mobs.tick(now, players)) {
    const mob = mobs.mobOf(ev.mobId);
    if (mob) onMobEvent(ev, mob.pos);
  }

  // Mob movement fan-out (only mobs that actually moved/state-flipped).
  for (const mob of mobs.mobs.values()) {
    if (!mob.alive) { lastMobBroadcast.delete(mob.id); continue; }
    const last = lastMobBroadcast.get(mob.id);
    const moved = !last
      || Math.hypot(mob.pos.x - last.x, mob.pos.z - last.z) >= MOB_BROADCAST_MIN_STEP
      || last.state !== mob.state;
    if (moved) {
      lastMobBroadcast.set(mob.id, { x: mob.pos.x, z: mob.pos.z, state: mob.state });
      broadcastAtPos(mob.pos, {
        t: 'mobMove', mobId: mob.id, pos: mob.pos, yaw: mob.yaw,
        state: mob.state === 'dead' ? 'idle' : mob.state,
      });
    }
  }

  // Training dummy DPS reset (last attacker left the 10m radius).
  dummy.maybeReset(players);
}, TICK_MS);

http.listen(PORT, () => {
  console.log(`[breachborn-server] listening on :${PORT} (ws + /healthz)`);
});
