// World state: characters, identity registry, AOI filtering, join/despawn.
// Pure (no ws imports) — transport glue lives in index.ts (story 2.1).
import type { RosterEntry, Vec3 } from '@breachborn/shared';

export type Anim = 'idle' | 'walk' | 'run' | 'jump';

export type Char = {
  charId: string;
  name: string;
  race: string;
  level: number;
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

export class World {
  readonly chars = new Map<string, Char>();
  readonly registry = new Map<string, CharRecord>();
  violations = 0;

  join(opts: { charId: string; name: string; race: string; now: number; restore: boolean }): { char: Char; restored: boolean } {
    const rec = this.registry.get(opts.charId);
    const restored = opts.restore && rec !== undefined;
    const pos: Vec3 = restored && rec ? { ...rec.lastPos } : { ...SPAWN };
    const char: Char = {
      charId: opts.charId,
      name: opts.name,
      race: opts.race,
      level: rec?.level ?? 1,
      pos,
      yaw: 0,
      anim: 'idle',
      lastSeen: opts.now,
    };
    this.chars.set(char.charId, char);
    this.registry.set(char.charId, {
      charId: char.charId, name: char.name, race: char.race,
      level: char.level, lastPos: pos, disconnectedAt: 0,
    });
    return { char, restored };
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

  rosterFor(charId: string): RosterEntry[] {
    return this.othersInAoi(charId).map((c) => ({ charId: c.charId, name: c.name, level: c.level }));
  }
}
