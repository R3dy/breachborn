import { describe, it, expect } from 'vitest';
import type { Vec3 } from '@breachborn/shared';
import { LEASH_RANGE, MOB_TYPES } from '@breachborn/shared';
import { DamageLedger } from './combat.ts';
import { Mobs, Dummy, MOB_SPAWNS as SPAWNS, type PlayerView } from './mobs.ts';

const P = (x: number, z: number): Vec3 => ({ x, y: 2.2, z });
const MOB_ID = SPAWNS[0]!.id; // mob-glim-1 (glimmerling, home 12,-24)
const HOME = SPAWNS[0]!.pos;

function player(id: string, x: number, z: number): PlayerView {
  return { id, pos: P(x, z), alive: true };
}

function freshMobs(): Mobs {
  return new Mobs(new DamageLedger());
}

function distFromHome(mob: { pos: Vec3; home: Vec3 }): number {
  return Math.hypot(mob.pos.x - mob.home.x, mob.pos.z - mob.home.z);
}

function killMob(mobs: Mobs, mobId: string, killer: string, now: number): void {
  mobs.applyDamage(mobId, killer, 9999, now);
}

describe('canon parity', () => {
  it('MOB_SPAWNS use canon stats and 8 fixed points near paths/spire', () => {
    expect(SPAWNS).toHaveLength(8);
    expect(MOB_TYPES.glimmerling.hp).toBe(30);
    expect(MOB_TYPES['warden-drone'].hp).toBe(55);
    expect(MOB_TYPES['warden-drone'].windupMs).toBeGreaterThan(MOB_TYPES.glimmerling.windupMs);
  });
});

describe('aggro', () => {
  it('aggros the nearest player inside the aggro radius', () => {
    const mobs = freshMobs();
    const events = mobs.tick(100, [player('p1', HOME.x + 5, HOME.z), player('p2', HOME.x + 3, HOME.z)]);
    const mob = mobs.mobOf(MOB_ID)!;
    expect(mob.state).toBe('chase');
    expect(mob.targetId).toBe('p2'); // 3m closer than p1
    expect(events.filter((e) => e.kind === 'telegraph')).toHaveLength(0); // not in attack range yet
  });

  it('stays idle when nobody is within the aggro radius', () => {
    const mobs = freshMobs();
    mobs.tick(100, [player('p1', HOME.x, HOME.z + MOB_TYPES.glimmerling.aggroRadius + 1)]);
    expect(mobs.mobOf(MOB_ID)!.state).toBe('idle');
  });

  it('ignores dead players (never targets a corpse)', () => {
    const mobs = freshMobs();
    const dead: PlayerView = { id: 'corpse', pos: P(HOME.x + 1, HOME.z), alive: false };
    mobs.tick(100, [dead]);
    expect(mobs.mobOf(MOB_ID)!.state).toBe('idle');
  });

  it('re-aggros when damaged while idle', () => {
    const mobs = freshMobs();
    expect(mobs.mobOf(MOB_ID)!.state).toBe('idle');
    mobs.applyDamage(MOB_ID, 'sniper', 5, 100);
    const mob = mobs.mobOf(MOB_ID)!;
    expect(mob.state).toBe('chase');
    expect(mob.targetId).toBe('sniper');
  });
});

describe('chase + windup (telegraph) + damage timing', () => {
  it('chases at canon speed (distance shrinks with dt)', () => {
    const mobs = freshMobs();
    mobs.tick(0, [player('p1', HOME.x + 6, HOME.z)]); // aggro
    const before = Math.abs(mobs.mobOf(MOB_ID)!.pos.x - (HOME.x + 6));
    mobs.tick(250, [player('p1', HOME.x + 6, HOME.z)]); // 250ms at speed 3.2 → 0.8m
    const after = Math.abs(mobs.mobOf(MOB_ID)!.pos.x - (HOME.x + 6));
    expect(before - after).toBeCloseTo(0.8, 1);
  });

  it('starts a windup telegraph only when in attack range + cooldown ready', () => {
    const mobs = freshMobs();
    const close = player('p1', HOME.x + 1, HOME.z);
    const events = mobs.tick(1000, [close]);
    const telegs = events.filter((e) => e.kind === 'telegraph');
    expect(telegs).toHaveLength(1);
    expect(telegs[0]).toMatchObject({ mobId: MOB_ID, ms: MOB_TYPES.glimmerling.windupMs });
    // mid-windup tick: no second telegraph, no hit
    expect(mobs.tick(1000 + 300, [close]).filter((e) => e.kind === 'telegraph' || e.kind === 'hit')).toHaveLength(0);
  });

  it('damage lands ONLY after the windup completes', () => {
    const mobs = freshMobs();
    const close = player('p1', HOME.x + 1, HOME.z);
    mobs.tick(1000, [close]); // telegraph starts, ends at 1000+700
    expect(mobs.tick(1000 + MOB_TYPES.glimmerling.windupMs - 1, [close]).filter((e) => e.kind === 'hit')).toHaveLength(0);
    const events = mobs.tick(1000 + MOB_TYPES.glimmerling.windupMs + 1, [close]);
    const hits = events.filter((e) => e.kind === 'hit');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ mobId: MOB_ID, targetId: 'p1', amount: MOB_TYPES.glimmerling.dmg });
  });

  it('windup damage whiffs if the victim left range during the windup', () => {
    const mobs = freshMobs();
    mobs.tick(1000, [player('p1', HOME.x + 1, HOME.z)]);
    const events = mobs.tick(1000 + MOB_TYPES.glimmerling.windupMs + 1, [player('p1', HOME.x + 30, HOME.z)]);
    expect(events.filter((e) => e.kind === 'hit')).toHaveLength(0);
  });

  it('windup damage whiffs if the victim died mid-windup', () => {
    const mobs = freshMobs();
    mobs.tick(1000, [player('p1', HOME.x + 1, HOME.z)]);
    const dead: PlayerView = { id: 'p1', pos: P(HOME.x + 1, HOME.z), alive: false };
    const events = mobs.tick(1000 + MOB_TYPES.glimmerling.windupMs + 1, [dead]);
    expect(events.filter((e) => e.kind === 'hit')).toHaveLength(0);
  });
});

describe('leash — no stuck states', () => {
  it('drops aggro + walks home when the target is >40m from the spawn', () => {
    const mobs = freshMobs();
    const near = player('p1', HOME.x + 6, HOME.z);
    mobs.tick(0, [near]); // aggro
    for (let t = 250; t <= 2000; t += 250) mobs.tick(t, [near]); // mob closes in, leaves home
    const mob = mobs.mobOf(MOB_ID)!;
    expect(mob.state).toBe('chase');
    expect(distFromHome(mob)).toBeGreaterThan(1); // genuinely away from the spawn point
    const far = player('p1', HOME.x + LEASH_RANGE + 5, HOME.z);
    mobs.tick(2100, [far]);
    expect(mob.state).toBe('return');
    expect(mob.targetId).toBeNull();
    // walks home over successive ticks and settles to idle
    for (let t = 2300; t <= 40000; t += 250) mobs.tick(t, [far]);
    expect(mob.state).toBe('idle');
    expect(mob.pos.x).toBeCloseTo(HOME.x, 1);
    expect(mob.pos.z).toBeCloseTo(HOME.z, 1);
  });

  it('a leashed mob that never left home drops straight to idle (no stuck return loop)', () => {
    const mobs = freshMobs();
    mobs.tick(0, [player('p1', HOME.x + 6, HOME.z)]); // aggro, no movement yet
    mobs.tick(100, [player('p1', HOME.x + LEASH_RANGE + 5, HOME.z)]); // target flees instantly
    const mob = mobs.mobOf(MOB_ID)!;
    expect(mob.targetId).toBeNull();
    expect(mob.state === 'idle' || mob.state === 'return').toBe(true);
    mobs.tick(400, []);
    expect(mob.state).toBe('idle');
  });

  it('drops aggro when the target disconnects mid-chase', () => {
    const mobs = freshMobs();
    mobs.tick(0, [player('p1', HOME.x + 6, HOME.z)]);
    expect(mobs.mobOf(MOB_ID)!.state).toBe('chase');
    mobs.tick(200, []); // p1 gone
    const mob = mobs.mobOf(MOB_ID)!;
    expect(mob.state).toBe('return');
    expect(mob.targetId).toBeNull();
  });
});

describe('death → respawn 20s → top-damage XP credit', () => {
  it('dies, respawns at 20s at full hp at home, top damager gets the XP', () => {
    const ledger = new DamageLedger();
    const mobs = new Mobs(ledger);
    // a lands 12, b lands 20 → b is top damager
    expect(mobs.applyDamage(MOB_ID, 'a', 12, 1000).died).toBe(false);
    const kill = mobs.applyDamage(MOB_ID, 'b', 20, 1100);
    expect(kill).toMatchObject({ died: true, killerId: 'b', xp: MOB_TYPES.glimmerling.xp });
    expect(mobs.mobOf(MOB_ID)!.alive).toBe(false);

    // before 20s: no respawn
    expect(mobs.tick(1100 + MOB_TYPES.glimmerling.respawnMs - 1, []).filter((e) => e.kind === 'respawn')).toHaveLength(0);
    // at 20s: respawn event, full hp, idle at home
    const events = mobs.tick(1100 + MOB_TYPES.glimmerling.respawnMs, []);
    const respawns = events.filter((e) => e.kind === 'respawn');
    expect(respawns.map((e) => (e as { mobId: string }).mobId)).toContain(MOB_ID);
    const mob = mobs.mobOf(MOB_ID)!;
    expect(mob.alive).toBe(true);
    expect(mob.hp).toBe(mob.maxHp);
    expect(mob.pos).toEqual(HOME);
    expect(mob.state).toBe('idle');
  });

  it('a dead mob takes no further damage', () => {
    const mobs = freshMobs();
    killMob(mobs, MOB_ID, 'a', 1000);
    expect(mobs.applyDamage(MOB_ID, 'a', 10, 1100)).toMatchObject({ applied: 0, died: false });
  });
});

describe('training dummy', () => {
  it('records rolling DPS per attacker inside the 10s window', () => {
    const d = new Dummy();
    d.recordHit('a', 100, 0);
    d.recordHit('a', 100, 5000);
    // 200 damage over a 10s window → 20 dps
    expect(d.dpsFor('a', 6000)).toBeCloseTo(20, 5);
    // 15s in: both hits pruned only after 15s; at 14s the second hit (at 5s)
    // is still inside the 10s window → 100 damage / 10s = 10 dps
    expect(d.dpsFor('a', 14000)).toBeCloseTo(10, 5);
    expect(d.dpsFor('a', 15001)).toBeCloseTo(0, 5);
  });

  it('tracks attackers independently', () => {
    const d = new Dummy();
    d.recordHit('a', 50, 0);
    d.recordHit('b', 300, 1000);
    expect(d.dpsFor('a', 2000)).toBeCloseTo(5, 5);
    expect(d.dpsFor('b', 2000)).toBeCloseTo(30, 5);
    expect(d.attackerCount()).toBe(2);
  });

  it('resets when the last attacker leaves the 10m radius', () => {
    const d = new Dummy();
    d.recordHit('a', 100, 0);
    d.recordHit('b', 100, 0);
    // both near → stays
    expect(d.maybeReset([player('a', d.pos.x + 2, d.pos.z)])).toBe(false);
    // a leaves but b stays → stays
    expect(d.maybeReset([player('a', d.pos.x + 30, d.pos.z), player('b', d.pos.x + 1, d.pos.z)])).toBe(false);
    // everyone out → reset
    expect(d.maybeReset([player('a', d.pos.x + 30, d.pos.z)])).toBe(true);
    expect(d.attackerCount()).toBe(0);
    expect(d.dpsFor('a', 1000)).toBe(0);
  });

  it('is unkillable: asTarget stays alive forever', () => {
    const d = new Dummy();
    d.recordHit('a', 99999, 0);
    expect(d.asTarget().alive).toBe(true);
  });
});

it('leash constant matches canon LEASH_RANGE', () => {
  expect(LEASH_RANGE).toBe(40);
});
