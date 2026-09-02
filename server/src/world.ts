// World state: characters, identity registry, AOI filtering, join/despawn,
// movement validation. Pure (no ws imports) — transport glue in index.ts.
import type { RosterEntry, Vec3 } from '@breachborn/shared';
import { MOVEMENT } from '@breachborn/shared';

export type Anim = 'idle' | 'walk' | 'run' | 'jump';

export type Char = {
  charId: string;
  name: string;
  race: string;
  level: number;
  xp: number;
  pos: Vec3;
  yaw: number;
  anim: Anim;
  lastSeen: number;
  partyId?: string; // shared-quest-credit stub (story 2.3 consumes this)
};

// In-memory identity records: token → character resolution + reconnect state.
// SQLite persistence lands in story 7.1.
export type CharRecord = {
  charId: string;
  name: string;
  race: string;
  level: number;
  xp: number;
  lastPos: Vec3;
  disconnectedAt: number;
};

// Fixed spawn point — matches the client's M1 spawn (x=4, z=-12, ground+2.2).
export const SPAWN: Vec3 = { x: 4, y: 2.2, z: -12 };
export const AOI_RADIUS = 90; // view radius (m) for movement/roster visibility
export const RECONNECT_GRACE_MS = 5000; // <5s reconnect restores state

const ANIMS: readonly Anim[] = ['idle', 'walk', 'run', 'jump'];
export function isAnim(v: unknown): v is Anim {
  return typeof v === 'string' && (ANIMS as readonly string[]).includes(v);
}

// Server-side anticheat (canon formula): WALK_SPEED * SPRINT_MULT *
// MAX_SERVER_DELTA_PER_TICK — the max distance accepted per movement update.
export const MOVE_CLAMP = MOVEMENT.WALK_SPEED * MOVEMENT.SPRINT_MULT * MOVEMENT.MAX_SERVER_DELTA_PER_TICK;

export type MoveVerdict = 'accepted' | 'clamped' | 'rejected';

// Validate a claimed move against the char's last accepted position.
// - accepted: within the clamp → take the client pos (client-predicted world)
// - clamped : beyond the clamp → take the farthest point along the claimed
//             direction (world stays continuous, cheat gains nothing extra)
// - rejected: non-finite garbage → keep server pos entirely
export function validateMove(from: Vec3, to: Vec3): { verdict: MoveVerdict; pos: Vec3 } {
  if (!Number.isFinite(to.x) || !Number.isFinite(to.y) || !Number.isFinite(to.z)) {
    return { verdict: 'rejected', pos: from };
  }
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist <= MOVE_CLAMP) return { verdict: 'accepted', pos: { ...to } };
  const k = MOVE_CLAMP / dist;
  return { verdict: 'clamped', pos: { x: from.x + dx * k, y: from.y + dy * k, z: from.z + dz * k } };
}

export class World {
  readonly chars = new Map<string, Char>();
  readonly registry = new Map<string, CharRecord>();
  violations = 0;

  join(opts: { charId: string; name: string; race: string; now: number; restore: boolean }): { char: Char; restored: boolean } {
    const rec = this.registry.get(opts.charId);
    // <5s reconnect restores the character's last state (AC story 2.1).
    const restored = opts.restore && rec !== undefined
      && rec.disconnectedAt > 0
      && opts.now - rec.disconnectedAt < RECONNECT_GRACE_MS;
    const pos: Vec3 = restored && rec ? { ...rec.lastPos } : { ...SPAWN };
    const char: Char = {
      charId: opts.charId,
      name: opts.name,
      race: opts.race,
      level: rec?.level ?? 1,
      xp: rec?.xp ?? 0,
      pos,
      yaw: 0,
      anim: 'idle',
      lastSeen: opts.now,
    };
    this.chars.set(char.charId, char);
    this.registry.set(char.charId, {
      charId: char.charId, name: char.name, race: char.race,
      level: char.level, xp: char.xp, lastPos: pos, disconnectedAt: 0,
    });
    return { char, restored };
  }

  // Server-side XP award (story 3.2: mob kills). Level curve lands in 5.4.
  addXp(charId: string, amount: number): number {
    const char = this.chars.get(charId);
    const rec = this.registry.get(charId);
    if (char) char.xp += amount;
    if (rec) rec.xp = char ? char.xp : rec.xp + amount;
    return char?.xp ?? rec?.xp ?? 0;
  }

  // Removes from the live shard; keeps the registry record for reconnects.
  disconnect(charId: string, now: number): Char | null {
    const char = this.chars.get(charId);
    if (!char) return null;
    this.chars.delete(charId);
    const rec = this.registry.get(charId);
    if (rec) {
      rec.name = char.name;
      rec.level = char.level;
      rec.xp = char.xp;
      rec.lastPos = { ...char.pos };
      rec.disconnectedAt = now;
    }
    return char;
  }

  byName(name: string): Char | undefined {
    for (const c of this.chars.values()) if (c.name === name) return c;
    return undefined;
  }

  othersInAoi(charId: string): Char[] {
    const me = this.chars.get(charId);
    if (!me) return [];
    const out: Char[] = [];
    const r2 = AOI_RADIUS * AOI_RADIUS;
    for (const c of this.chars.values()) {
      if (c.charId === charId) continue;
      const dx = c.pos.x - me.pos.x;
      const dy = c.pos.y - me.pos.y;
      const dz = c.pos.z - me.pos.z;
      if (dx * dx + dy * dy + dz * dz <= r2) out.push(c);
    }
    return out;
  }

  // Every live char within `radius` of a world position — how combat/mob
  // events find their audience (mobs aren't chars, so they anchor the AOI).
  charsInRange(pos: Vec3, radius: number): Char[] {
    const out: Char[] = [];
    const r2 = radius * radius;
    for (const c of this.chars.values()) {
      const dx = c.pos.x - pos.x;
      const dy = c.pos.y - pos.y;
      const dz = c.pos.z - pos.z;
      if (dx * dx + dy * dy + dz * dz <= r2) out.push(c);
    }
    return out;
  }

  rosterFor(charId: string): RosterEntry[] {
    return this.othersInAoi(charId).map((c) => ({ charId: c.charId, name: c.name, level: c.level }));
  }

  // Server-authoritative movement: validate, mutate the char, count violations.
  applyMovement(char: Char, pos: Vec3, yaw: number, anim: string, now: number): MoveVerdict {
    if (!Number.isFinite(yaw) || !isAnim(anim)) {
      this.violations++;
      return 'rejected';
    }
    const v = validateMove(char.pos, pos);
    if (v.verdict === 'rejected' || v.verdict === 'clamped') this.violations++;
    char.pos = v.pos;
    char.yaw = yaw;
    char.anim = anim;
    char.lastSeen = now;
    return v.verdict;
  }
}
