// Mobs + training dummy — PURE, unit-testable (story 3.2). Transport glue in
// index.ts. AI runs on a fixed server tick: aggro → chase → telegraphed
// windup → damage → death → respawn, with leash + no-stuck-state guarantees.
import { DUMMY, LEASH_RANGE, MOB_TYPES, type MobStats, type MobType, type Vec3 } from '@breachborn/shared';
import { DamageLedger, dist2d, type AttackTarget } from './combat.ts';

// Fixed spawn points on the island — along the spawn-ring→spire path and
// around the spire (drones guard the spire, glimmerlings haunt the paths).
export type MobSpawnDef = { id: string; type: MobType; pos: Vec3; yaw: number };

export const MOB_SPAWNS: readonly MobSpawnDef[] = [
  { id: 'mob-glim-1', type: 'glimmerling', pos: { x: 12, y: 2.2, z: -24 }, yaw: 2.4 },
  { id: 'mob-glim-2', type: 'glimmerling', pos: { x: -4, y: 2.2, z: -30 }, yaw: 1.6 },
  { id: 'mob-glim-3', type: 'glimmerling', pos: { x: 26, y: 2.2, z: -30 }, yaw: -2.0 },
  { id: 'mob-glim-4', type: 'glimmerling', pos: { x: 2, y: 2.2, z: -46 }, yaw: 0.4 },
  { id: 'mob-glim-5', type: 'glimmerling', pos: { x: 28, y: 2.2, z: -56 }, yaw: 3.0 },
  { id: 'mob-drone-1', type: 'warden-drone', pos: { x: 14, y: 2.2, z: -42 }, yaw: 0 },
  { id: 'mob-drone-2', type: 'warden-drone', pos: { x: 24, y: 2.2, z: -64 }, yaw: 0.8 },
  { id: 'mob-drone-3', type: 'warden-drone', pos: { x: -8, y: 2.2, z: -52 }, yaw: -1.2 },
];

export type MobState = 'idle' | 'chase' | 'return' | 'dead';

export type Mob = {
  id: string;
  type: MobType;
  stats: MobStats;
  pos: Vec3;
  yaw: number;
  home: Vec3;
  homeYaw: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  state: MobState;
  targetId: string | null;
  windupEndsAt: number;      // telegraph in flight when > 0
  windupTargetId: string | null;
  nextAttackAt: number;
  lastTickAt: number;
  respawnAt: number;
};

export type PlayerView = { id: string; pos: Vec3; alive: boolean };

export type MobEvent =
  | { kind: 'telegraph'; mobId: string; ms: number }
  | { kind: 'hit'; mobId: string; targetId: string; amount: number }
  | { kind: 'death'; mobId: string; killerId: string | null; xp: number }
  | { kind: 'respawn'; mobId: string };

const MAX_STEP_MS = 250; // clamp dt so a stalled tick can't teleport mobs

function moveTo(pos: Vec3, to: Vec3, step: number): void {
  const dx = to.x - pos.x;
  const dz = to.z - pos.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d <= step || d === 0) {
    pos.x = to.x;
    pos.z = to.z;
    return;
  }
  pos.x += (dx / d) * step;
  pos.z += (dz / d) * step;
}

export class Mobs {
  readonly mobs = new Map<string, Mob>();
  private readonly ledger: DamageLedger;

  constructor(ledger: DamageLedger) {
    this.ledger = ledger;
    const now = 0;
    for (const def of MOB_SPAWNS) this.spawnOne(def, now);
  }

  private spawnOne(def: MobSpawnDef, now: number): void {
    const stats = MOB_TYPES[def.type];
    const mob: Mob = {
      id: def.id,
      type: def.type,
      stats,
      pos: { ...def.pos },
      yaw: def.yaw,
      home: { ...def.pos },
      homeYaw: def.yaw,
      hp: stats.hp,
      maxHp: stats.hp,
      alive: true,
      state: 'idle',
      targetId: null,
      windupEndsAt: 0,
      windupTargetId: null,
      nextAttackAt: 0,
      lastTickAt: now,
      respawnAt: 0,
    };
    this.mobs.set(def.id, mob);
  }

  mobOf(id: string): Mob | undefined {
    return this.mobs.get(id);
  }

  // Shim so the shared pure swing math works against mobs (mobs never dodge).
  asTarget(mob: Mob): AttackTarget {
    return { id: mob.id, pos: mob.pos, alive: mob.alive, dodgeUntil: 0 };
  }

  // Server-authoritative damage intake for a mob. Returns the swing outcome
  // plus kill/xp data when the hit lands lethally. Top-damage credit wins.
  applyDamage(
    mobId: string,
    attackerId: string,
    amount: number,
    now: number,
  ): { applied: number; died: boolean; killerId: string | null; xp: number } {
    const mob = this.mobs.get(mobId);
    if (!mob || !mob.alive || amount <= 0) return { applied: 0, died: false, killerId: null, xp: 0 };
    const applied = Math.min(mob.hp, amount);
    mob.hp -= applied;
    this.ledger.record(mobId, attackerId, applied);
    if (mob.hp <= 0) {
      mob.hp = 0;
      mob.alive = false;
      mob.state = 'dead';
      mob.targetId = null;
      mob.windupEndsAt = 0;
      mob.windupTargetId = null;
      mob.respawnAt = now + mob.stats.respawnMs;
      const killerId = this.ledger.topDamager(mobId) ?? attackerId;
      const xp = mob.stats.xp;
      this.ledger.clear(mobId);
      return { applied, died: true, killerId, xp };
    }
    // Getting hit re-aggros the attacker (never a stuck passive mob).
    if (mob.state === 'idle' || mob.state === 'return') {
      mob.state = 'chase';
      mob.targetId = attackerId;
    }
    return { applied, died: false, killerId: null, xp: 0 };
  }

  // One AI tick for every mob. Players are the (already-validated) target pool.
  tick(now: number, players: readonly PlayerView[]): MobEvent[] {
    const events: MobEvent[] = [];
    const byId = new Map<string, PlayerView>();
    for (const p of players) if (p.alive) byId.set(p.id, p);

    for (const mob of this.mobs.values()) {
      const dtMs = Math.max(0, Math.min(MAX_STEP_MS, now - mob.lastTickAt));
      mob.lastTickAt = now;

      if (!mob.alive) {
        if (mob.respawnAt > 0 && now >= mob.respawnAt) {
          mob.alive = true;
          mob.hp = mob.maxHp;
          mob.state = 'idle';
          mob.targetId = null;
          mob.windupEndsAt = 0;
          mob.windupTargetId = null;
          mob.nextAttackAt = 0;
          mob.pos = { ...mob.home };
          mob.yaw = mob.homeYaw;
          events.push({ kind: 'respawn', mobId: mob.id });
        }
        continue;
      }

      // Leash FIRST — even a mob mid-windup abandons the fight when the
      // target (or the mob itself) gets too far from the spawn point.
      const chaseTargetId = mob.targetId ?? mob.windupTargetId;
      const leashTarget = chaseTargetId !== null ? byId.get(chaseTargetId) : undefined;
      if (
        (leashTarget && dist2d(leashTarget.pos, mob.home) > LEASH_RANGE) ||
        dist2d(mob.pos, mob.home) > LEASH_RANGE * 1.2
      ) {
        mob.state = 'return';
        mob.targetId = null;
        mob.windupEndsAt = 0;
        mob.windupTargetId = null;
      }

      if (mob.state === 'return') {
        const d = dist2d(mob.pos, mob.home);
        if (d < 0.4) {
          mob.pos = { ...mob.home };
          mob.yaw = mob.homeYaw;
          mob.state = 'idle';
        } else {
          mob.yaw = Math.atan2(mob.home.x - mob.pos.x, mob.home.z - mob.pos.z);
          moveTo(mob.pos, mob.home, mob.stats.speed * (dtMs / 1000));
        }
        continue;
      }

      // Telegraph in flight: damage lands ONLY after the windup completes.
      if (mob.windupTargetId !== null) {
        if (now < mob.windupEndsAt) continue; // still winding up
        const victim = byId.get(mob.windupTargetId);
        mob.windupTargetId = null;
        mob.windupEndsAt = 0;
        mob.nextAttackAt = now + mob.stats.attackCooldownMs;
        if (victim && dist2d(mob.pos, victim.pos) <= mob.stats.attackRange * 1.25) {
          events.push({ kind: 'hit', mobId: mob.id, targetId: victim.id, amount: mob.stats.dmg });
        }
        continue;
      }

      const target = mob.targetId !== null ? byId.get(mob.targetId) : undefined;
      if (mob.state === 'chase') {
        if (!target) {
          mob.state = 'return';
          mob.targetId = null;
        } else {
          chaseStep(mob, target, now, dtMs, events);
        }
      } else {
        // idle: scan for the nearest player inside the aggro radius; if found,
        // chase behavior runs the same tick (aggro never wastes a beat).
        let nearest: PlayerView | null = null;
        let bestD = mob.stats.aggroRadius;
        for (const p of byId.values()) {
          const d = dist2d(mob.pos, p.pos);
          if (d < bestD) { bestD = d; nearest = p; }
        }
        if (nearest) {
          mob.state = 'chase';
          mob.targetId = nearest.id;
          chaseStep(mob, nearest, now, dtMs, events);
        }
      }
    }
    return events;
  }
}

// One chase tick: face the target, wind up in range, or close the gap.
function chaseStep(mob: Mob, target: PlayerView, now: number, dtMs: number, events: MobEvent[]): void {
  const d = dist2d(mob.pos, target.pos);
  mob.yaw = Math.atan2(target.pos.x - mob.pos.x, target.pos.z - mob.pos.z);
  if (d <= mob.stats.attackRange) {
    if (now >= mob.nextAttackAt) {
      mob.windupEndsAt = now + mob.stats.windupMs;
      mob.windupTargetId = target.id;
      events.push({ kind: 'telegraph', mobId: mob.id, ms: mob.stats.windupMs });
    }
  } else {
    moveTo(mob.pos, target.pos, mob.stats.speed * (dtMs / 1000));
  }
}

// ---- Training dummy (near the spawn ring) ----
// Infinite HP; records rolling DPS per attacker; resets when the last
// attacker wanders out of RESET_RADIUS.

type DummyHit = { at: number; amount: number };

export class Dummy {
  readonly id = DUMMY.ID;
  readonly pos: Vec3 = { ...DUMMY.POS };
  private hits = new Map<string, DummyHit[]>();

  // Always survives.
  asTarget(): AttackTarget {
    return { id: this.id, pos: this.pos, alive: true, dodgeUntil: 0 };
  }

  recordHit(attackerId: string, amount: number, now: number): void {
    if (amount <= 0) return;
    let list = this.hits.get(attackerId);
    if (!list) { list = []; this.hits.set(attackerId, list); }
    list.push({ at: now, amount });
  }

  // Rolling DPS inside DPS_WINDOW_MS (prunes as it reads).
  dpsFor(attackerId: string, now: number): number {
    const list = this.hits.get(attackerId);
    if (!list || list.length === 0) return 0;
    let total = 0;
    let kept = 0;
    for (const h of list) {
      if (now - h.at <= DUMMY.DPS_WINDOW_MS) { total += h.amount; kept++; }
    }
    if (kept !== list.length) this.hits.set(attackerId, list.filter((h) => now - h.at <= DUMMY.DPS_WINDOW_MS));
    return total / (DUMMY.DPS_WINDOW_MS / 1000);
  }

  // Reset when every recorded attacker has left the reset radius (or logged off).
  maybeReset(players: readonly PlayerView[]): boolean {
    if (this.hits.size === 0) return false;
    let anyNear = false;
    for (const p of players) {
      if (this.hits.has(p.id) && dist2d(p.pos, this.pos) <= DUMMY.RESET_RADIUS) { anyNear = true; break; }
    }
    if (!anyNear) {
      this.hits.clear();
      return true;
    }
    return false;
  }

  attackerCount(): number {
    return this.hits.size;
  }
}
