// Combat core — PURE, unit-testable (story 3.1). Transport glue in index.ts.
// Server-authoritative: clients send INTENTS; every number here is computed
// server-side from canon (@breachborn/shared). Clients never send damage.
import { COMBAT, type Vec3 } from '@breachborn/shared';

// ---- Intent validation (anti-cheat seam) ----

export type CombatIntent =
  | { t: 'attack'; target?: string }
  | { t: 'dodge' }
  | { t: 'cast'; target?: string };

// The ONLY thing a client may send on `combat`. Anything else — unknown kinds
// ('damage'), or damage-shaped fields (amount/hp/crit) — is fabricated and
// rejected. Returns null for anything not a legal intent.
export function validateCombatIntent(
  raw: { t?: unknown; kind?: unknown; target?: unknown; amount?: unknown; hp?: unknown; crit?: unknown },
): CombatIntent | null {
  if (raw.t !== 'combat') return null;
  if ('amount' in raw || 'hp' in raw || 'crit' in raw) return null;
  if (raw.kind === 'attack') {
    if (raw.target !== undefined && (typeof raw.target !== 'string' || raw.target.length === 0 || raw.target.length > 64)) return null;
    return { t: 'attack', target: raw.target === undefined ? undefined : raw.target };
  }
  if (raw.kind === 'dodge') return { t: 'dodge' };
  if (raw.kind === 'cast') {
    if (raw.target !== undefined && (typeof raw.target !== 'string' || raw.target.length > 64)) return null;
    return { t: 'cast', target: raw.target === undefined ? undefined : raw.target };
  }
  return null;
}

// ---- Geometry / derived stats ----

export function dist2d(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

// Vigor attribute stub — allocation UI lands in story 5.4; formula is canon.
export function maxHpFor(vigor: number): number {
  return COMBAT.PLAYER_BASE_HP + Math.max(0, vigor) * COMBAT.HP_PER_VIGOR;
}

// Spire base — death respawn anchor (canon: "respawn at last anchor/spire base").
export const SPIRE_BASE: Vec3 = { x: 14, y: 2.2, z: -44 };

// ---- Kill-credit ledger (top-damage wins) ----

export class DamageLedger {
  private byTarget = new Map<string, Map<string, number>>();

  record(targetId: string, attackerId: string, amount: number): void {
    if (amount <= 0) return;
    let per = this.byTarget.get(targetId);
    if (!per) { per = new Map(); this.byTarget.set(targetId, per); }
    per.set(attackerId, (per.get(attackerId) ?? 0) + amount);
  }

  topDamager(targetId: string): string | null {
    let top: string | null = null;
    let best = 0;
    const per = this.byTarget.get(targetId);
    if (!per) return null;
    for (const [attacker, total] of per) {
      if (total > best) { best = total; top = attacker; }
    }
    return top;
  }

  clear(targetId: string): void {
    this.byTarget.delete(targetId);
  }
}

// ---- Fighters (player-side combat state) ----

export type Fighter = {
  id: string;
  pos: Vec3;
  facing: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  vigor: number;
  comboStage: number;   // next swing index (0..2), wraps
  lastSwingAt: number;  // combo window anchor + swing cooldown
  dodgeUntil: number;   // i-frames end (ms epoch)
  nextDodgeAt: number;  // dodge cooldown end
  deathAt: number;
  respawnAt: number;
  driftUntil: number;   // 'unlogged drift' debuff flag (15s after respawn)
};

export type SwingError = 'self-dead' | 'on-cooldown' | 'no-target' | 'target-dead' | 'out-of-range';

// What a swing computes BEFORE any damage is applied — callers apply to the
// right subsystem (fighter vs mob vs dummy). Keeps one pure damage model.
export type Swing =
  | { ok: true; stage: number; amount: number; crit: boolean; dodged: boolean; targetId: string }
  | { ok: false; error: SwingError };

// Everything the swing math needs from a target — fighters, mobs, and the
// dummy all conform structurally.
export type AttackTarget = {
  id: string;
  pos: Vec3;
  alive: boolean;
  dodgeUntil: number;
};

export function swing(
  attacker: Fighter,
  target: AttackTarget | undefined,
  now: number,
  rng: () => number,
): Swing {
  if (!attacker.alive) return { ok: false, error: 'self-dead' };
  if (attacker.lastSwingAt !== 0 && now - attacker.lastSwingAt < COMBAT.ATTACK_COOLDOWN_MS) {
    return { ok: false, error: 'on-cooldown' };
  }
  if (!target) return { ok: false, error: 'no-target' };
  if (!target.alive) return { ok: false, error: 'target-dead' };
  if (dist2d(attacker.pos, target.pos) > COMBAT.MELEE_RANGE) return { ok: false, error: 'out-of-range' };

  // Combo stage: advances within the window, resets outside it, wraps at 3.
  const inWindow = now - attacker.lastSwingAt <= COMBAT.COMBO_WINDOW_MS || attacker.lastSwingAt === 0;
  const stage = inWindow ? attacker.comboStage % COMBAT.COMBO_STAGES : 0;
  attacker.comboStage = (stage + 1) % COMBAT.COMBO_STAGES;
  attacker.lastSwingAt = now;

  // I-frames negate damage entirely — the swing connects, the dodge wins.
  if (now < target.dodgeUntil) {
    return { ok: true, stage, amount: 0, crit: false, dodged: true, targetId: target.id };
  }

  const base = COMBAT.BASE_DAMAGE[stage] ?? 0;
  const crit = rng() < COMBAT.CRIT_CHANCE;
  const amount = crit ? base * COMBAT.CRIT_MULT : base;
  return { ok: true, stage, amount, crit, dodged: false, targetId: target.id };
}

export type DamageResult = { applied: number; killed: boolean };

export function applyDamage(target: Fighter, amount: number, now: number): DamageResult {
  if (!target.alive || amount <= 0) return { applied: 0, killed: false };
  const applied = Math.min(target.hp, amount);
  target.hp -= applied;
  let killed = false;
  if (target.hp <= 0) {
    target.hp = 0;
    target.alive = false;
    killed = true;
    target.deathAt = now;
    target.respawnAt = now + COMBAT.DEATH_RESPAWN_MS;
    target.comboStage = 0;
  }
  return { applied, killed };
}

// Fighter as a generic AttackTarget (mobs/dummy use their own shims).
export function asTarget(f: Fighter): AttackTarget {
  return { id: f.id, pos: f.pos, alive: f.alive, dodgeUntil: f.dodgeUntil };
}

export type RespawnedFighter = { id: string; pos: Vec3; hp: number; maxHp: number };

export class Combat {
  readonly fighters = new Map<string, Fighter>();
  readonly ledger = new DamageLedger();

  join(charId: string, pos: Vec3, now: number, vigor = 0): Fighter {
    const maxHp = maxHpFor(vigor);
    const f: Fighter = {
      id: charId,
      pos: { ...pos },
      facing: 0,
      hp: maxHp,
      maxHp,
      alive: true,
      vigor,
      comboStage: 0,
      lastSwingAt: 0,
      dodgeUntil: 0,
      nextDodgeAt: 0,
      deathAt: 0,
      respawnAt: 0,
      driftUntil: 0,
    };
    this.fighters.set(charId, f);
    return f;
  }

  leave(charId: string): void {
    this.fighters.delete(charId);
    this.ledger.clear(charId);
  }

  fighterOf(charId: string): Fighter | undefined {
    return this.fighters.get(charId);
  }

  syncPos(charId: string, pos: Vec3, facing: number): void {
    const f = this.fighters.get(charId);
    if (!f) return;
    f.pos.x = pos.x; f.pos.y = pos.y; f.pos.z = pos.z;
    f.facing = facing;
  }

  // Dodge-roll: i-frames now→+300ms, then 1200ms cooldown. Dead souls can't roll.
  startDodge(f: Fighter, now: number): { ok: boolean; until: number } {
    if (!f.alive) return { ok: false, until: 0 };
    if (now < f.nextDodgeAt) return { ok: false, until: f.nextDodgeAt };
    f.dodgeUntil = now + COMBAT.DODGE_IFRAMES_MS;
    f.nextDodgeAt = now + COMBAT.DODGE_COOLDOWN_MS;
    return { ok: true, until: f.dodgeUntil };
  }

  // Full intent→damage pipeline for a fighter-vs-fighter swing (PvP / dummy
  // shims reuse `swing` directly). Applies damage + kill-credit when it lands.
  resolveFighterAttack(attacker: Fighter, targetId: string, now: number, rng: () => number): Swing {
    const target = this.fighters.get(targetId);
    if (!target || target.id === attacker.id) return { ok: false, error: 'no-target' };
    const s = swing(attacker, asTarget(target), now, rng);
    if (!s.ok || s.dodged || s.amount <= 0) return s;
    const res = applyDamage(target, s.amount, now);
    this.ledger.record(targetId, attacker.id, res.applied);
    return { ...s, amount: res.applied };
  }

  // Player damage intake (mob hits route here through the transport): honors
  // i-frames + kill credit against the mob's ledger caller-side.
  damageChar(charId: string, amount: number, now: number): DamageResult & { dodged: boolean } | null {
    const f = this.fighters.get(charId);
    if (!f) return null;
    if (now < f.dodgeUntil) return { dodged: true, applied: 0, killed: false };
    const res = applyDamage(f, amount, now);
    return { ...res, dodged: false };
  }

  // Respawn pass: dead fighters past their timer rematerialize at the spire
  // base with full HP and the 15s 'unlogged drift' debuff flag set.
  tick(now: number): RespawnedFighter[] {
    const out: RespawnedFighter[] = [];
    for (const f of this.fighters.values()) {
      if (f.alive || now < f.respawnAt) continue;
      f.alive = true;
      f.hp = f.maxHp;
      f.pos = { ...SPIRE_BASE };
      f.comboStage = 0;
      f.driftUntil = now + COMBAT.DRIFT_DEBUFF_MS;
      out.push({ id: f.id, pos: { ...SPIRE_BASE }, hp: f.hp, maxHp: f.maxHp });
    }
    return out;
  }
}
