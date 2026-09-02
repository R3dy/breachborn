// Game server: ws transport + HTTP /healthz on :8080.
// All world/social logic lives in pure modules (auth.ts, world.ts, social.ts);
// this file only routes protocol frames (CONVENTIONS.md).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { ClientMsg, ServerMsg } from '@breachborn/shared';
import { World } from './world.ts';
import { issueToken, verifyToken, newCharId, validateName, fallbackName, dedupeName, escapeHtml, sanitizeName } from './auth.ts';

type HelloMsg = Extract<ClientMsg, { t: 'hello' }>;

const PORT = Number(process.env.PORT ?? 8080);
const world = new World();
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
      case 'party':
      case 'emote':
        return; // story 2.3
    }
  });

  ws.on('close', () => {
    if (!charId) return;
    if (byChar.get(charId) !== ws) return; // a newer connection replaced this one
    byChar.delete(charId);
    const left = world.disconnect(charId, Date.now());
    if (left) broadcastAoi(left.charId, { t: 'despawn', charId: left.charId });
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

http.listen(PORT, () => {
  console.log(`[breachborn-server] listening on :${PORT} (ws + /healthz)`);
});
