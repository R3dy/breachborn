// Game server: ws transport + HTTP /healthz on :8080.
// All world/social logic lives in pure modules (auth.ts, world.ts, social.ts);
// this file only routes protocol frames (CONVENTIONS.md).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { ClientMsg, ServerMsg } from '@breachborn/shared';
import { World, type Char } from './world.ts';
import { Social, isEmote, sanitizeChat } from './social.ts';
import { issueToken, verifyToken, newCharId, validateName, fallbackName, dedupeName, escapeHtml, sanitizeName } from './auth.ts';

type HelloMsg = Extract<ClientMsg, { t: 'hello' }>;
type ChatMsg = Extract<ClientMsg, { t: 'chat' }>;
type PartyMsg = Extract<ClientMsg, { t: 'party' }>;

const PORT = Number(process.env.PORT ?? 8080);
const world = new World();
const social = new Social();
const byChar = new Map<string, WebSocket>();

const http = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ chars: world.chars.size, violations: world.violations }));
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
        // Client sends at 10Hz; server validates then forwards at the same
        // cadence (within the 10-20Hz budget). Clamped moves broadcast the
        // server-corrected position so the world stays continuous.
        const verdict = world.applyMovement(char, msg.pos, msg.yaw, msg.anim, Date.now());
        if (verdict !== 'rejected') {
          broadcastAoi(charId, {
            t: 'movement', charId,
            pos: char.pos, yaw: char.yaw, anim: char.anim,
          });
        }
        return;
      }
      case 'combat':
      case 'quest':
      case 'terminal':
        return; // arrives in M3+ / M4+
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
  byChar.set(char.charId, ws);
  setCharId(char.charId);

  sendTo(ws, {
    t: 'welcome',
    charId: char.charId,
    name: char.name,
    level: char.level,
    xp: 0,
    pos: char.pos,
    token: issueToken(char.charId, now),
    roster: world.rosterFor(char.charId),
  });
  // Backfill: spawn frames for everyone already visible to the joiner.
  for (const other of world.othersInAoi(char.charId)) {
    sendTo(ws, { t: 'spawn', charId: other.charId, name: other.name, pos: other.pos });
  }
  // Announce the joiner to everyone who can see them.
  broadcastAoi(char.charId, { t: 'spawn', charId: char.charId, name: char.name, pos: char.pos });
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

http.listen(PORT, () => {
  console.log(`[breachborn-server] listening on :${PORT} (ws + /healthz)`);
});
