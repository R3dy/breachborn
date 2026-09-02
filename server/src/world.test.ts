import { describe, it, expect } from 'vitest';
import { World, validateMove, MOVE_CLAMP } from './world.ts';

const V = (x: number, y = 2.2, z = -12) => ({ x, y, z });

describe('movement validation (anticheat-lite)', () => {
  it('accepts a valid move', () => {
    const from = V(0, 0, 0);
    const res = validateMove(from, V(1, 0, 1));
    expect(res.verdict).toBe('accepted');
    expect(res.pos).toEqual({ x: 1, y: 0, z: 1 });
  });

  it('accepts a max-speed move right at the clamp boundary', () => {
    const from = V(0, 0, 0);
    const res = validateMove(from, V(MOVE_CLAMP, 0, 0));
    expect(res.verdict).toBe('accepted');
  });

  it('clamps a teleport beyond the clamp + counts a violation', () => {
    const w = new World();
    const { char } = w.join({ charId: 'c1', name: 'Alaric', race: 'Aelfon', now: 0, restore: false });
    const res = w.applyMovement(char, V(500, 2.2, 500), 0, 'walk', 10);
    expect(res).toBe('clamped');
    expect(w.violations).toBe(1);
    // clamped position stays within MOVE_CLAMP of the last accepted pos
    const d = Math.hypot(char.pos.x - 4, char.pos.y - 2.2, char.pos.z + 12);
    expect(d).toBeLessThanOrEqual(MOVE_CLAMP + 1e-9);
  });

  it('rejects non-finite garbage moves and keeps server pos', () => {
    const w = new World();
    const { char } = w.join({ charId: 'c1', name: 'Alaric', race: 'Aelfon', now: 0, restore: false });
    const res = w.applyMovement(char, { x: Number.NaN, y: 2.2, z: -12 }, 0, 'walk', 10);
    expect(res).toBe('rejected');
    expect(w.violations).toBe(1);
    expect(char.pos).toEqual({ x: 4, y: 2.2, z: -12 });
  });

  it('rejects bogus anim values', () => {
    const w = new World();
    const { char } = w.join({ charId: 'c1', name: 'Alaric', race: 'Aelfon', now: 0, restore: false });
    expect(w.applyMovement(char, V(4.5), 0, 'fly', 10)).toBe('rejected');
    expect(w.applyMovement(char, V(4.5), Number.NaN, 'walk', 10)).toBe('rejected');
    expect(w.violations).toBe(2);
  });

  it('accepts a sequence of sprint-speed moves without violations', () => {
    const w = new World();
    const { char } = w.join({ charId: 'c1', name: 'Alaric', race: 'Aelfon', now: 0, restore: false });
    let x = char.pos.x;
    for (let i = 0; i < 20; i++) {
      const verdict = w.applyMovement(char, V(x + MOVE_CLAMP * 0.95), 0, 'run', i * 100);
      expect(verdict).toBe('accepted');
      x = char.pos.x;
    }
    expect(w.violations).toBe(0);
  });
});

describe('AOI + reconnect restore', () => {
  it('roster only includes chars within the 90m view radius', () => {
    const w = new World();
    void w.join({ charId: 'a', name: 'Near', race: 'Aelfon', now: 0, restore: false });
    const far = w.join({ charId: 'b', name: 'Far', race: 'Aelfon', now: 0, restore: false }).char;
    far.pos = { x: 50, y: 2.2, z: -12 };
    expect(w.rosterFor('a').map((r) => r.name)).toEqual(['Far']);
    far.pos = { x: 200, y: 2.2, z: -12 };
    expect(w.rosterFor('a')).toEqual([]);
    expect(w.othersInAoi('b')).toEqual([]);
  });

  it('reconnect <5s restores position; later reconnect respawns', () => {
    const w = new World();
    w.join({ charId: 'c1', name: 'Alaric', race: 'Aelfon', now: 0, restore: false });
    w.disconnect('c1', 1000);
    const again = w.join({ charId: 'c1', name: 'Alaric', race: 'Aelfon', now: 3000, restore: true });
    expect(again.restored).toBe(true);
    expect(again.char.pos).toEqual({ x: 4, y: 2.2, z: -12 });
    w.disconnect('c1', 4000);
    const late = w.join({ charId: 'c1', name: 'Alaric', race: 'Aelfon', now: 50_000, restore: true });
    expect(late.restored).toBe(false);
  });

  it('valid applyMovement updates char state', () => {
    const w = new World();
    const { char } = w.join({ charId: 'c1', name: 'Alaric', race: 'Aelfon', now: 0, restore: false });
    expect(w.applyMovement(char, V(4.5, 2.2, -11.5), 1.2, 'walk', 5)).toBe('accepted');
    expect(char.pos).toEqual({ x: 4.5, y: 2.2, z: -11.5 });
    expect(char.yaw).toBe(1.2);
    expect(char.anim).toBe('walk');
  });
});
