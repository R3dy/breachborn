import { describe, it, expect } from 'vitest';
import { applyTrace, decayTrace, traceState, TRACE, TOPOLOGY } from './canon.ts';

describe('trace math', () => {
  it('gains clamp at MAX', () => {
    expect(applyTrace(97, TRACE.LOGWIPE)).toBe(TRACE.MAX);
  });
  it('decays toward zero, never below', () => {
    expect(decayTrace(5, 100)).toBe(0);
    expect(decayTrace(40, 10)).toBeCloseTo(36, 5);
  });
  it('states: idle < 60, watching 60-99, alert at 100', () => {
    expect(traceState(0)).toBe('idle');
    expect(traceState(59.9)).toBe('idle');
    expect(traceState(60)).toBe('watching');
    expect(traceState(99.9)).toBe('watching');
    expect(traceState(100)).toBe('alert');
  });
});

describe('topology canon (environment.md)', () => {
  it('vault.spire exposes spiresh 3.4.1 with VULN 2026-12-0314', () => {
    const ssh = TOPOLOGY['vault.spire'].services.find(s => s.service === 'glyph-ssh');
    expect(ssh?.version).toBe('spiresh 3.4.1');
    expect(ssh?.vuln).toBe('2026-12-0314');
  });
  it('hearth-ward glyph-shell 1.0.0 has VULN 2026-11-0777', () => {
    const gs = TOPOLOGY['hearth-ward'].services.find(s => s.service === 'glyph-shell');
    expect(gs?.version).toBe('1.0.0');
    expect(gs?.vuln).toBe('2026-11-0777');
  });
  it('443 on vault.spire is filtered', () => {
    expect(TOPOLOGY['vault.spire'].services.find(s => s.port === '443/tcp')?.state).toBe('filtered');
  });
});
