# Site Launch Hub Radar Data

Public, versioned Steam opportunity evidence and the collector that produces it.

## Repository contents

- `collector/`: a published mirror of the collector source from `VastNext/site-launch-hub`
- `steam/latest.json`: latest complete payload
- `steam/runs/`: immutable collection payloads
- `steam/snapshots/`: compact hourly evidence history
- `manifests/latest.json`: checksum and provenance for the latest run
- `schema/`: public payload schema

Only public, sanitized evidence belongs here. Never commit credentials, cookies, user or tenant data, watchlists, sessions, Cloudflare D1 files, or local SQLite databases.

## Collection modes

The application supports one active scheduler at a time:

- `github-actions`: this public repository collects on GitHub-hosted runners and imports the committed payload into Cloudflare D1.
- `cloudflare`: a Cloudflare Cron Worker calls the protected Pages collection endpoint; this repository's scheduled job skips collection.
- `local`: no remote scheduler is active; an operator runs the CLI in the application repository.

Set the repository variable `RADAR_COLLECTION_MODE=github-actions` to enable the scheduled workflow here. Manual dispatch remains available for recovery and replay.

For runner and upstream canaries before D1 credentials are configured, dispatch with `collect_only=true`. That mode validates a live payload but intentionally skips Git persistence and D1 synchronization.

## Required GitHub configuration

- Repository variable: `RADAR_COLLECTION_MODE`
- Actions secret: `RADAR_INGEST_URL`
- Actions secret: `RADAR_INGEST_SECRET`
- Optional Actions secret: `SERPER_API_KEY`

The workflow uses the repository-scoped `GITHUB_TOKEN` to commit data. It does not need a deploy key or access to the private application repository.

## Local collector

Node.js 22 or newer is sufficient; the collector has no install step and no third-party runtime dependencies.

```bash
node --experimental-strip-types collector/scripts/radar/collect.ts \
  --output /tmp/radar-payload.json

node --experimental-strip-types collector/scripts/radar/persist-data.ts \
  --payload /tmp/radar-payload.json \
  --repo .
```

The `collector/` tree is generated from the application repository. Changes should be made there first, then published with `pnpm radar:kit:export -- --repo <path>`.
