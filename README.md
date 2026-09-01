# BREACHBORN — Quarantine Spire (MVP)

Fantasy MMORPG × real red-team tradecraft. Browser-native, zero-install.

- `client/` — Vite + TypeScript + Three.js (port 5173)
- `server/` — Node + ws authoritative game server (port 8080)
- `shared/` — protocol types + canon constants (single source of truth with `docs/environment.md`)
- `tools/` — headless Chrome capture + perf probes
- `docs/` — pointer to project docs (`../../docs/` in the project workspace)

## Run (dev)

```bash
npm install
npm run dev:server   # :8080
npm run dev:client   # :5173
```

## Test / verify

```bash
npm test             # vitest (shared canon + pure logic)
npm run typecheck    # strict tsc across all workspaces
npm run build        # all workspaces
```
