// Wire protocol per ADR-008 — single source of truth for client + server.
// JSON frames over WS; compact keys on the wire, typed here.

export type Vec3 = { x: number; y: number; z: number };

// Client → server combat is INTENT ONLY. Any damage-shaped fields on a
// client `combat` frame are fabricated (anti-cheat, story 3.1) — the server
// validates with validateCombatIntent and drops/count violators.
export type ClientMsg =
  | { t: 'hello'; name: string; race: string; token?: string }
  | { t: 'movement'; seq: number; ts: number; pos: Vec3; yaw: number; anim: 'idle' | 'walk' | 'run' | 'jump' }
  | { t: 'combat'; kind: 'attack' | 'dodge' | 'cast'; target?: string; stage?: number }
  | { t: 'quest'; questId: string; objectiveId: string }
  | { t: 'terminal'; session: string; cmd: string }
  | { t: 'chat'; channel: 'local' | 'party'; text: string }
  | { t: 'party'; action: 'invite' | 'accept' | 'leave'; who?: string }
  | { t: 'emote'; emote: string }
  | { t: 'ping'; ts: number };

// Server → client combat EVENT kinds:
//   attack  — a swing started (anim sync; stage = combo stage 0..2)
//   hit     — damage landed (amount/crit authoritative; target = victim id)
//   dodge   — a hit was negated by i-frames (target = victim id)
//   death   — victim died (charId or mobId)
//   respawn — char rematerialized (spire base)
//   dps     — training-dummy DPS log readout (mobId = dummy id)
export type CombatEventKind = 'attack' | 'hit' | 'dodge' | 'death' | 'respawn' | 'dps';

export type ServerMsg =
  | { t: 'welcome'; charId: string; name: string; level: number; xp: number; pos: Vec3; token: string; roster: RosterEntry[] }
  | { t: 'spawn'; charId: string; name: string; pos: Vec3 }
  | { t: 'despawn'; charId: string }
  | { t: 'movement'; charId: string; pos: Vec3; yaw: number; anim: 'idle' | 'walk' | 'run' | 'jump' }
  | { t: 'combat'; charId?: string; mobId?: string; kind: CombatEventKind; amount?: number; crit?: boolean; target?: string; stage?: number }
  | { t: 'hp'; charId: string; hp: number; maxHp: number }
  | { t: 'xp'; amount: number; total: number }
  | { t: 'death'; respawnInMs: number }
  | { t: 'respawn'; pos: Vec3 }
  | { t: 'quest'; questId: string; objectives: QuestObjective[]; completed: boolean }
  | { t: 'terminal'; session: string; out: TerminalOut }
  | { t: 'chat'; from: string; channel: 'local' | 'party'; text: string }
  | { t: 'party'; members: string[] }
  | { t: 'partyInvite'; from: string }
  | { t: 'emote'; charId: string; emote: string }
  | { t: 'trace'; value: number; state: 'idle' | 'watching' | 'alert' }
  | { t: 'pong'; ts: number; pos?: Vec3 }
  | { t: 'error'; code: string; message: string };

export type RosterEntry = { charId: string; name: string; level: number };
export type QuestObjective = { id: string; label: string; done: boolean; progress?: number; need?: number };
export type TerminalOut = { kind: 'ok' | 'err' | 'warn' | 'info' | 'gold'; text: string };
