import { describe, it, expect } from 'vitest';
import type { Vec3 } from '@breachborn/shared';
import {
  Combat, validateCombatIntent, swing, applyDamage, asTarget, maxHpFor, SPIRE_BASE,
  type Fighter,
} from './combat.ts';
import { COMBAT } from '@breachborn/shared';

const P = (x: number, z: number): Vec3 => ({ x, y: 2.2, z });
const NO_CRIT = () => 0.99; // rng above CRIT_CHANCE → never crits
const ALWAYS_CRIT = () => 0.01;

function mkFighter(id: string, pos: Vec3 = P(0, 0), now = 0): Fighter {
  return new Combat().join(id, pos, now);
}

function dodgeSetup(c: Combat, victimId: string, now: number): Fighter {
  const victim = c.fighterOf(victimId)!;
  c.startDodge(victim, now);
  return victim;
}

describe('validateCombatIntent (anti-cheat seam)', () => {
  it('accepts clean attack/dodge/cast intents', () => {
    expect(validateCombatIntent({ t: 'combat', kind: 'attack', target: 'mob-glim-1' }))
      .toEqual({ t: 'attack', target: 'mob-glim-1' });
    expect(validateCombatIntent({ t: 'combat', kind: 'attack' })).toEqual({ t: 'attack', target: undefined });
    expect(validateCombatIntent({ t: 'combat', kind: 'dodge' })).toEqual({ t: 'dodge' });
    expect(validateCombatIntent({ t: 'combat', kind: 'cast', target: 'x' })).toEqual({ t: 'cast', target: 'x' });
  });

  it('rejects fabricated damage kinds ("damage")', () => {
    expect(validateCombatIntent({ t: 'combat', kind: 'damage', target: 'c1' })).toBeNull();
    expect(validateCombatIntent({ t: 'combat', kind: 'heal', amount: 10 })).toBeNull();
  });

  it('rejects any intent carrying damage-shaped fields (amount/hp/crit)', () => {
    expect(validateCombatIntent({ t: 'combat', kind: 'attack', target: 'c1', amount: 9999 })).toBeNull();
    expect(validateCombatIntent({ t: 'combat', kind: 'dodge', hp: 100 })).toBeNull();
    expect(validateCombatIntent({ t: 'combat', kind: 'attack', crit: true })).toBeNull();
  });

  it('rejects malformed targets and non-combat frames', () => {
    expect(validateCombatIntent({ t: 'combat', kind: 'attack', target: 42 })).toBeNull();
    expect(validateCombatIntent({ t: 'movement', kind: 'attack' })).toBeNull();
  });
});

describe('combo damage + windows', () => {
  it('deals per-stage canon damage 12 → 14 → 20 within the window, then wraps to 12', () => {
    const c = new Combat();
    const a = c.join('a', P(0, 0), 0);
    const b = c.join('b', P(1, 0), 0);
    let r = c.resolveFighterAttack(a, 'b', 100, NO_CRIT);
    expect(r).toMatchObject({ ok: true, stage: 0, amount: COMBAT.BASE_DAMAGE[0], dodged: false });
    r = c.resolveFighterAttack(a, 'b', 550, NO_CRIT); // within cooldown+window
    expect(r).toMatchObject({ ok: true, stage: 1, amount: COMBAT.BASE_DAMAGE[1] });
    r = c.resolveFighterAttack(a, 'b', 1000, NO_CRIT);
    expect(r).toMatchObject({ ok: true, stage: 2, amount: COMBAT.BASE_DAMAGE[2] });
    r = c.resolveFighterAttack(a, 'b', 1450, NO_CRIT);
    expect(r).toMatchObject({ ok: true, stage: 0, amount: COMBAT.BASE_DAMAGE[0] });
    // total applied matches sum of stages (b took all four hits)
    expect(b.hp).toBe(b.maxHp - (12 + 14 + 20 + 12));
  });

  it('resets the combo to stage 0 after the window lapses', () => {
    const c = new Combat();
    const a = c.join('a', P(0, 0), 0);
    void c.join('b', P(1, 0), 0);
    expect(c.resolveFighterAttack(a, 'b', 100, NO_CRIT)).toMatchObject({ stage: 0 });
    expect(c.resolveFighterAttack(a, 'b', 600, NO_CRIT)).toMatchObject({ stage: 1 });
    // beyond COMBO_WINDOW_MS since the last swing → back to stage 0
    expect(c.resolveFighterAttack(a, 'b', 600 + COMBAT.COMBO_WINDOW_MS + 500, NO_CRIT))
      .toMatchObject({ stage: 0, amount: COMBAT.BASE_DAMAGE[0] });
  });

  it('enforces the swing cooldown (spam produces no state change)', () => {
    const c = new Combat();
    const a = c.join('a', P(0, 0), 0);
    void c.join('b', P(1, 0), 0);
    expect(c.resolveFighterAttack(a, 'b', 100, NO_CRIT)).toMatchObject({ ok: true });
    const hpBefore = c.fighterOf('b')!.hp;
    const stageBefore = a.comboStage;
    const r = c.resolveFighterAttack(a, 'b', 100 + 50, NO_CRIT);
    expect(r).toEqual({ ok: false, error: 'on-cooldown' });
    expect(c.fighterOf('b')!.hp).toBe(hpBefore);
    expect(a.comboStage).toBe(stageBefore);
  });

  it('rejects out-of-range swings without damage or combo advance', () => {
    const c = new Combat();
    const a = c.join('a', P(0, 0), 0);
    void c.join('b', P(10, 0), 0);
    const r = c.resolveFighterAttack(a, 'b', 100, NO_CRIT);
    expect(r).toEqual({ ok: false, error: 'out-of-range' });
    expect(c.fighterOf('b')!.hp).toBe(c.fighterOf('b')!.maxHp);
    expect(a.comboStage).toBe(0);
  });

  it('boundary: exactly MELEE_RANGE connects, beyond does not', () => {
    const a = mkFighter('a');
    const t: Fighter = { ...mkFighter('b', P(COMBAT.MELEE_RANGE, 0)) };
    expect(swing(a, asTarget(t), 1000, NO_CRIT)).toMatchObject({ ok: true });
    const far = { ...mkFighter('c', P(COMBAT.MELEE_RANGE + 0.01, 0)) };
    expect(swing(a, asTarget(far), 2000, NO_CRIT)).toEqual({ ok: false, error: 'out-of-range' });
  });
});

describe('dodge i-frames + cooldown', () => {
  it('i-frames negate damage; swings still consume (dodged=true)', () => {
    const c = new Combat();
    const a = c.join('a', P(0, 0), 0);
    void c.join('b', P(1, 0), 0);
    const victim = dodgeSetup(c, 'b', 1000); // i-frames 1000→1300
    const r = c.resolveFighterAttack(a, 'b', 1100, NO_CRIT);
    expect(r).toMatchObject({ ok: true, dodged: true, amount: 0 });
    expect(victim.hp).toBe(victim.maxHp);
    // after i-frames lapse (and the combo window), the swing connects at stage 0
    const r2 = c.resolveFighterAttack(a, 'b', 1000 + COMBAT.COMBO_WINDOW_MS + 500, NO_CRIT);
    expect(r2).toMatchObject({ dodged: false, stage: 0, amount: COMBAT.BASE_DAMAGE[0] });
    expect(victim.hp).toBe(victim.maxHp - COMBAT.BASE_DAMAGE[0]);
  });

  it('dodge cooldown blocks re-roll within 1200ms, allows after', () => {
    const c = new Combat();
    const v = c.join('v', P(0, 0), 0);
    expect(c.startDodge(v, 1000).ok).toBe(true);
    expect(c.startDodge(v, 1000 + 500).ok).toBe(false);
    expect(c.startDodge(v, 1000 + COMBAT.DODGE_COOLDOWN_MS - 1).ok).toBe(false);
    expect(c.startDodge(v, 1000 + COMBAT.DODGE_COOLDOWN_MS).ok).toBe(true);
  });

  it('dead souls cannot dodge', () => {
    const c = new Combat();
    const v = c.join('v', P(0, 0), 0);
    applyDamage(v, 999, 100);
    expect(c.startDodge(v, 200).ok).toBe(false);
  });
});

describe('crits', () => {
  it('rolls inside CRIT_CHANCE → 2x gold damage; outside → base', () => {
    const a = mkFighter('a');
    const t = mkFighter('b', P(1, 0));
    const critSwing = swing(a, asTarget(t), 1000, ALWAYS_CRIT);
    expect(critSwing).toMatchObject({ crit: true, amount: COMBAT.BASE_DAMAGE[0] * COMBAT.CRIT_MULT });
    a.lastSwingAt = 0; // reset cooldown/window for a clean second read
    a.comboStage = 0;
    const plain = swing(a, asTarget(t), 5000, NO_CRIT);
    expect(plain).toMatchObject({ crit: false, amount: COMBAT.BASE_DAMAGE[0] });
  });

  it('crit rng is bounded by the canon chance', () => {
    // rng exactly at the threshold: < CRIT_CHANCE crits, ≥ does not
    const a = mkFighter('a');
    const t = mkFighter('b', P(1, 0));
    expect(swing(a, asTarget(t), 1000, () => COMBAT.CRIT_CHANCE - 1e-9)).toMatchObject({ crit: true });
    a.lastSwingAt = 0; a.comboStage = 0;
    expect(swing(a, asTarget(t), 5000, () => COMBAT.CRIT_CHANCE)).toMatchObject({ crit: false });
  });
});

describe('death + respawn + drift debuff', () => {
  it('lethal damage zeroes hp, kills, and schedules the 5s respawn', () => {
    const c = new Combat();
    const v = c.join('v', P(0, 0), 0);
    const res = applyDamage(v, 999, 1000);
    expect(res).toEqual({ applied: v.maxHp, killed: true });
    expect(v.hp).toBe(0);
    expect(v.alive).toBe(false);
    expect(v.respawnAt).toBe(1000 + COMBAT.DEATH_RESPAWN_MS);
  });

  it('tick before the timer does nothing; after, respawn at spire base + drift flag', () => {
    const c = new Combat();
    const v = c.join('v', P(30, 30), 0);
    applyDamage(v, 999, 1000);
    expect(c.tick(1000 + COMBAT.DEATH_RESPAWN_MS - 1)).toEqual([]);
    const out = c.tick(1000 + COMBAT.DEATH_RESPAWN_MS + 5);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('v');
    expect(out[0]!.pos).toEqual(SPIRE_BASE);
    expect(v.alive).toBe(true);
    expect(v.hp).toBe(v.maxHp);
    expect(v.driftUntil).toBe(1000 + COMBAT.DEATH_RESPAWN_MS + 5 + COMBAT.DRIFT_DEBUFF_MS);
    // respawn is one-shot
    expect(c.tick(1000 + COMBAT.DEATH_RESPAWN_MS + 10)).toEqual([]);
  });
});

describe('kill credit + hp model', () => {
  it('top-damage wins the ledger', () => {
    const c = new Combat();
    void c.join('a', P(0, 0), 0);
    void c.join('b', P(2, 0), 0);
    c.ledger.record('mob-1', 'a', 12);
    c.ledger.record('mob-1', 'b', 14);
    expect(c.ledger.topDamager('mob-1')).toBe('b');
    c.ledger.record('mob-1', 'a', 2); // a 14 = tie → first to reach the top keeps it (a)
    expect(c.ledger.topDamager('mob-1')).toBe('a');
    c.ledger.record('mob-1', 'a', 10); // a 24
    expect(c.ledger.topDamager('mob-1')).toBe('a');
  });

  it('maxHpFor: base 100, Vigor +2/pt (stub)', () => {
    expect(maxHpFor(0)).toBe(100);
    expect(maxHpFor(5)).toBe(110);
    expect(maxHpFor(-3)).toBe(100);
  });

  it('damage clamps at 0 and ignores overkill application to the dead', () => {
    const v = mkFighter('v');
    expect(applyDamage(v, 30, 1)).toEqual({ applied: 30, killed: false });
    expect(applyDamage(v, 999, 2)).toEqual({ applied: 70, killed: true });
    expect(applyDamage(v, 10, 3)).toEqual({ applied: 0, killed: false });
  });
});
