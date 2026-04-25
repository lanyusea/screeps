# Private Server Version Pin Research

Date: 2026-04-26T04:29:43+08:00
Status: completed for dependency-install preflight; full runtime smoke still pending

## Objective

Continue the private-server-first validation path by testing whether the Dockerized `screepers/screeps-launcher:latest` image can avoid the `screeps@4.3.0` / Node.js `12.22.12` engine mismatch through an explicit Screeps package version pin.

## Findings

- Live Docker state was checked before private-server tooling work: no running private-server containers were listed by `docker ps`; local images include `screepers/screeps-launcher:latest`, `mongo:8`, and `redis:7`.
- The current launcher image is `screepers/screeps-launcher:latest` with OCI version label `v1.16.2` and source `https://github.com/screepers/screeps-launcher`.
- The launcher default config uses `version: latest`, which makes `launcher/packages.go` write `"screeps": "*"` into the generated server `package.json`.
- Because the current npm latest resolves to `screeps@4.3.0`, the launcher image fails under its bundled Node.js `12.22.12` runtime.
- npm metadata shows `screeps@4.2.21` declares engines `node >=10.13.0` and `npm >=3.10.3`, making it compatible with the launcher's Node 12 runtime.
- A Dockerized `screeps-launcher apply` preflight with `version: 4.2.21` completed successfully.

## Commands verified

```bash
npm view screeps@4.3.0 engines --json
npm view screeps@4.2.21 engines dependencies --json
docker image inspect screepers/screeps-launcher:latest
docker run --rm -v "$TMP:/screeps" screepers/screeps-launcher:latest apply
cd prod && npm run typecheck && npm test -- --runInBand && npm run build
```

## Successful temporary config shape

No secrets were used or printed in this preflight.

```yaml
version: 4.2.21
nodeVersion: Erbium
pinnedPackages:
  ssri: 8.0.1
  cacache: 15.3.0
  passport-steam: 1.0.17
  minipass-fetch: 2.1.2
  express-rate-limit: 6.7.0
  psl: 1.10.0
mods: []
bots: {}
```

The launcher generated:

```json
{
  "dependencies": {
    "screeps": "4.2.21"
  },
  "resolutions": {
    "cacache": "15.3.0",
    "express-rate-limit": "6.7.0",
    "minipass-fetch": "2.1.2",
    "passport-steam": "1.0.17",
    "psl": "1.10.0",
    "ssri": "8.0.1"
  }
}
```

## Verification result

- `screeps-launcher apply` with `version: 4.2.21`: passed; dependencies installed and `mods.json` was written.
- `cd prod && npm run typecheck`: passed.
- `cd prod && npm test -- --runInBand`: passed, 12 suites / 45 tests.
- `cd prod && npm run build`: passed.

## Remaining work

This resolves the first install-time version mismatch hypothesis but does **not** yet complete private-server runtime validation. The next bounded slice should retry a full private-server smoke with the pinned `version: 4.2.21` config, Mongo/Redis if needed, and local untracked secrets/config only. If the pinned runtime starts, proceed to CLI reset, code injection/upload, owned-room setup, and runtime tick observation.
