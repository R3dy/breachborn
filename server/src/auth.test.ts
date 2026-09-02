import { describe, it, expect } from 'vitest';
import {
  issueToken, verifyToken, sanitizeName, validateName, dedupeName,
  escapeHtml, fallbackName, TOKEN_TTL_SEC,
} from './auth.ts';

describe('session tokens', () => {
  it('sign → verify roundtrip', () => {
    const tok = issueToken('abc123', 1_700_000_000_000);
    expect(verifyToken(tok, 1_700_000_000_000 + 1000)).toEqual({
      charId: 'abc123', iat: 1_700_000_000,
    });
  });

  it('rejects a tampered token', () => {
    const tok = issueToken('abc123');
    const sig = tok.slice(tok.lastIndexOf('.') + 1);
    const flipped = sig.endsWith('A') ? `${sig.slice(0, -1)}B` : `${sig.slice(0, -1)}A`;
    expect(verifyToken(`${tok.slice(0, tok.lastIndexOf('.') + 1)}${flipped}`)).toBeNull();
    // tampered payload (charId changed, signature now mismatched)
    const parts = tok.split('.');
    expect(verifyToken(`ffff${parts[1]}.${parts[2]}`)).toBeNull();
  });

  it('rejects an expired token (30d TTL)', () => {
    const tok = issueToken('abc123', 0);
    expect(verifyToken(tok, (TOKEN_TTL_SEC + 60) * 1000)).toBeNull();
    expect(verifyToken(tok, (TOKEN_TTL_SEC - 60) * 1000)).not.toBeNull();
  });

  it('rejects malformed tokens', () => {
    expect(verifyToken('')).toBeNull();
    expect(verifyToken('nonsense')).toBeNull();
    expect(verifyToken('a.b')).toBeNull();
    expect(verifyToken('a.b.c.d')).toBeNull();
  });
});

describe('name sanitization', () => {
  it('strips non-printables and control chars', () => {
    expect(sanitizeName('  Al\u200Baric\u0000\t ')).toBe('Alaric');
    expect(sanitizeName('Kae\nl')).toBe('Kael');
  });

  it('HTML-escapes dangerous characters', () => {
    expect(escapeHtml('<b onload=alert(1)>')).toBe('&lt;b onload=alert(1)&gt;');
    expect(validateName('a&b<c>"d')).toBe('a&amp;b&lt;c&gt;&quot;d');
  });

  it('enforces 3-16 chars after sanitization', () => {
    expect(validateName('ab')).toBeNull();
    expect(validateName('   Kael   ')).toBe('Kael');
    expect(validateName('abcdefghijklmnop')).toBe('abcdefghijklmnop');
    expect(validateName('abcdefghijklmnopq')).toBeNull();
    // XSS payload exceeds the length cap once meaningful → rejected outright
    expect(validateName('<script>alert(1)</script>')).toBeNull();
  });
});

describe('duplicate-name suffix', () => {
  it('appends a deterministic #NNNN for the same base + world state', () => {
    const a = dedupeName('Alaric', new Set(['Alaric']));
    const b = dedupeName('Alaric', new Set(['Alaric']));
    expect(a).toBe(b);
    expect(a).toMatch(/^Alaric#\d{4}$/);
  });

  it('probes onward when the hashed suffix is also taken', () => {
    const taken = new Set(['Alaric']);
    const first = dedupeName('Alaric', taken);
    taken.add(first);
    const second = dedupeName('Alaric', taken);
    expect(second).toMatch(/^Alaric#\d{4}$/);
    expect(second).not.toBe(first);
    expect(dedupeName('Brann', taken)).toBe('Brann');
  });

  it('fallback names match wraith-XXXX', () => {
    expect(fallbackName()).toMatch(/^wraith-[0-9a-f]{4}$/);
  });
});
