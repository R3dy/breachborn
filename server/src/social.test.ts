import { describe, it, expect } from 'vitest';
import { Social, isEmote, sanitizeChat, type PartyChar } from './social.ts';

describe('chat rate limit (10 msgs / 10s sliding window)', () => {
  it('allows 10, throttles the 11th inside the window', () => {
    const s = new Social();
    for (let i = 0; i < 10; i++) {
      expect(s.allowChat('c1', i * 100)).toBe(true);
    }
    expect(s.allowChat('c1', 1000)).toBe(false);
    expect(s.allowChat('c1', 9000)).toBe(false); // still inside window
  });

  it('frees a slot once messages age out of the window', () => {
    const s = new Social();
    for (let i = 0; i < 10; i++) s.allowChat('c1', i * 100);
    expect(s.allowChat('c1', 1500)).toBe(false);
    expect(s.allowChat('c1', 10_100)).toBe(true); // first msg (t=0) aged out
  });

  it('tracks chars independently', () => {
    const s = new Social();
    for (let i = 0; i < 10; i++) s.allowChat('c1', i * 100);
    expect(s.allowChat('c2', 0)).toBe(true);
    expect(s.allowChat('c1', 1000)).toBe(false);
  });
});

describe('chat sanitizer', () => {
  it('neutralizes the XSS payload', () => {
    const out = sanitizeChat('hello <b onload=alert(1)>');
    expect(out).toBe('hello &lt;b onload=alert(1)&gt;');
    expect(out).not.toContain('<b');
  });

  it('escapes script tags and quotes', () => {
    const out = sanitizeChat('<script>alert("x")</script>');
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('"');
    expect(out).toContain('&lt;script&gt;');
  });

  it('length-caps input', () => {
    expect(sanitizeChat('a'.repeat(500)).length).toBeLessThanOrEqual(240);
  });
});

describe('emotes', () => {
  it('whitelists canon emotes only', () => {
    expect(isEmote('wave')).toBe(true);
    expect(isEmote('dance')).toBe(true);
    expect(isEmote('point')).toBe(true);
    expect(isEmote('hack')).toBe(false);
    expect(isEmote('')).toBe(false);
    expect(isEmote(42)).toBe(false);
  });
});

describe('parties (MAX 4)', () => {
  const chars = new Map<string, PartyChar>();
  const resolve = (id: string): PartyChar | undefined => chars.get(id);
  const mk = (id: string, name: string): PartyChar => {
    const c: PartyChar = { charId: id, name };
    chars.set(id, c);
    return c;
  };

  it('invite → accept forms a party and sets partyId on both', () => {
    const s = new Social();
    const a = mk('a', 'Alaric');
    const b = mk('b', 'Brann');
    expect(s.stageInvite(a, b)).toEqual({ ok: true });
    const res = s.acceptInvite(b, resolve);
    expect(res).toEqual({ ok: true, memberIds: ['a', 'b'] });
    expect(a.partyId).toBe(b.partyId);
    expect(a.partyId).toBeTruthy();
  });

  it('accept without a pending invite fails', () => {
    const s = new Social();
    const b = mk('b2', 'Brann');
    expect(s.acceptInvite(b, resolve).ok).toBe(false);
  });

  it('accept after the inviter left fails', () => {
    const s = new Social();
    const a = mk('a3', 'Alaric');
    const b = mk('b3', 'Brann');
    s.stageInvite(a, b);
    chars.delete('a3');
    expect(s.acceptInvite(b, resolve).ok).toBe(false);
  });

  it('enforces the 4-slot cap — the 5th join is denied', () => {
    const s = new Social();
    const a = mk('p-a', 'Alaric');
    const bs = ['p-b', 'p-c', 'p-d'].map((id, i) => mk(id, `B${i}`));
    for (const b of bs) {
      expect(s.stageInvite(a, b)).toEqual({ ok: true });
      expect(s.acceptInvite(b, resolve).ok).toBe(true);
    }
    // party now holds 4 (host + 3) — the next invite is refused at stage time
    const fifth = mk('p-f', 'Fenn');
    const res = s.stageInvite(a, fifth);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('party-full');
    // and accepting a never-staged invite is also refused
    expect(s.acceptInvite(fifth, resolve).ok).toBe(false);
  });

  it('leave removes the member and keeps the rest; empty party is deleted', () => {
    const s = new Social();
    const a = mk('la', 'Alaric');
    const b = mk('lb', 'Brann');
    s.stageInvite(a, b);
    s.acceptInvite(b, resolve);
    const res = s.leave(b);
    expect(res).toEqual({ ok: true, memberIds: ['la'] });
    expect(b.partyId).toBeUndefined();
    s.leave(a);
    expect(a.partyId).toBeUndefined();
    expect(s.leave(a).ok).toBe(false); // already out
  });

  it('rejects self-invites', () => {
    const s = new Social();
    const a = mk('sa', 'Alaric');
    const res = s.stageInvite(a, a);
    expect(res.ok).toBe(false);
  });
});
