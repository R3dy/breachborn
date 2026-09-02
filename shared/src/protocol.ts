// Wire protocol per ADR-008 — single source of truth for client + server.
// JSON frames over WS; compact keys on the wire, typed here.

export type Vec3 = { x: number; y: number; z: number };

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

export type ServerMsg =
  | { t: 'welcome'; charId: string; name: string; level: number; xp: number; pos: Vec3; token: string; roster: RosterEntry[] }
  | { t: 'spawn'; charId: string; name: string; pos: Vec3 }
  | { t: 'despawn'; charId: string }
  | { t: 'movement'; charId: string; pos: Vec3; yaw: number; anim: 'idle' | 'walk' | 'run' | 'jump' }
  | { t: 'combat'; charId: string; kind: string; amount?: number; crit?: boolean; target?: string }
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
