# Deployment Examples

## When to pick which deployment

- **Local SQLite** (default): single agent, single laptop. No setup. Existing behavior.
- **Single-host Postgres + pgvector**: one machine, multiple agent processes/containers
  sharing memory. See `docker-compose.example.yml`.
- **Distributed (multi-host)**: many agent containers across hosts pointing at one Postgres.
  Same compose, but the `opencode` service is scaled across hosts. `POOL_SIZE × CONTAINER_COUNT`
  must stay below Postgres's `max_connections`.
- **libSQL (Turso/sqld)**: hosted SQLite-compatible — pick when you want zero Postgres ops
  but still need shared memory across a small number of agents.

## Pairing matrix (which `vectorBackend` to use)

| recordStore | vectorBackend      | When to pick                                                                                       |
| ----------- | ------------------ | -------------------------------------------------------------------------------------------------- |
| sqlite      | usearch (default)  | Local default.                                                                                     |
| sqlite      | exact-scan         | Debugging / very small datasets.                                                                   |
| postgres    | pgvector (default) | Server-side ANN, scales to millions of rows. Requires pgvector.                                    |
| postgres    | usearch            | Pgvector unavailable on your managed DB. Each agent rebuilds an in-process HNSW from blob columns. |
| postgres    | exact-scan         | Small datasets, no extension.                                                                      |
| libsql      | usearch            | Hosted SQLite + per-agent HNSW.                                                                    |

## Migrating from SQLite to Postgres

```bash
npx opencode-mem-migrate \
  --to postgres \
  --url "$DATABASE_URL" \
  --vector-backend pgvector
```

The CLI is **idempotent** — re-running picks up where it left off
(`INSERT ... ON CONFLICT DO NOTHING` semantics, emulated at the app layer for v1).

## Connection pool sizing

Each agent container holds its own Postgres connection pool. With default
`storage.recordStore.poolSize = 4`, ten containers will hold 40 connections.
Watch `pg_stat_activity` and set `poolSize` lower if you scale wide.

## HNSW tuning

The default `m = 16, ef_construction = 64` from pgvector is a good baseline.
Raise `ef_construction` to 128 if recall is poor at the cost of index build time.

## Backup and restore

Use Postgres-native tools (`pg_dump`, `pg_basebackup`). This plugin does not
ship backup tooling.

## Out of scope

- Multi-region replication (use Postgres-native replication if needed).
- Reverse migration (remote → local).
- Hot-swap of vector backend at runtime (restart required).
