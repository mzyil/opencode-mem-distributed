# Distributed Memory — Storage Abstraction Design

**Status:** Approved — pending implementation plan
**Date:** 2026-05-20
**Author:** melih.yildiz@banxware.com
**Upstream target:** https://github.com/tickernelz/opencode-mem

## Goal

Turn the local-only, SQLite-shard-based `opencode-mem` plugin into a backend-agnostic
memory layer so multiple agent instances can share state through a remote database, while
keeping the existing local SQLite behavior byte-identical for current users. Land the work
upstream in three reviewable PRs developed as a stacked branch chain so they can be
implemented in one continuous push.

## Non-goals

- Replacing or rewriting the embedding pipeline. Embedding code stays where it is.
- Multi-region / geo-distributed consistency guarantees. Single remote DB is the model.
- A reverse migration tool (remote → local). Out of scope for v1.
- Hard tenant isolation at the DB level (separate schemas/databases per tenant). Logical
  scoping via `(scope, scope_hash)` columns is sufficient; tenant isolation is a
  deployment concern.

## Architecture overview

Two pluggable interfaces composed by a single orchestrator:

- `RecordStore` — durable storage of memory rows, including raw vector bytes when the
  paired vector backend needs them. CRUD, listing, scope discovery, vector iteration.
- `VectorBackend` — ANN insert/search/delete keyed by a `NamespaceKey`. Existing
  interface, generalized away from `ShardInfo`.
- `MemoryStore` — thin orchestrator that holds one `RecordStore` and one `VectorBackend`
  and exposes the same operations the current `vectorSearch + shardManager` combo does.
  All consumers import `MemoryStore` only.

### Module layout

```
src/services/
  storage/                       NEW — abstraction layer
    types.ts                     RecordStore, ScopeKey, MemoryRow, MemoryStore
    memory-store.ts              Orchestrates RecordStore + VectorBackend
    factory.ts                   Reads CONFIG → constructs store, validates pairings
    record-stores/
      sqlite-record-store.ts     Wraps existing shard/connection/vector-search
      postgres-record-store.ts   Kysely + pg dialect (PR #2)
      libsql-record-store.ts     Kysely + libsql dialect (PR #2)
    migrations/
      kysely-migrations/
        postgres/0001_initial.ts
        libsql/0001_initial.ts
      bootstrap.ts               Runs migrations on connect
    migrate-cli.ts               One-shot: local SQLite → remote (PR #2)
  vector-backends/               EXISTING — generalized in PR #1
    types.ts                     NamespaceKey replaces ShardInfo
    usearch-backend.ts           Updated to use NamespaceKey
    exact-scan-backend.ts        Updated
    pgvector-backend.ts          NEW — server-side ANN (PR #3)
    backend-factory.ts           Reads CONFIG
  sqlite/                        UNCHANGED, but wrapped by sqlite-record-store.ts
```

### Sync vs async

All `RecordStore` methods are `async`. The SQLite implementation wraps existing
synchronous `better-sqlite3` calls in `Promise.resolve(...)` — zero IO cost, but every
consumer in the chain becomes `async`. This is the largest mechanical change in PR #1.
Consumers affected: `api-handlers.ts`, `auto-capture.ts`, `deduplication-service.ts`,
`cleanup-service.ts`, `user-memory-learning.ts`, `migration-service.ts`,
`web-server.ts`, `web-server-worker.ts`.

## `RecordStore` interface

```ts
export interface ScopeKey {
  scope: "user" | "project";
  scopeHash: string;
}

export interface MemoryRow {
  id: string;
  content: string;
  containerTag: string;
  tags: string[] | null;
  type: string | null;
  createdAt: number; // Date.now() ms
  updatedAt: number;
  metadata: Record<string, unknown> | null;
  displayName: string | null;
  userName: string | null;
  userEmail: string | null;
  projectPath: string | null;
  projectName: string | null;
  gitRepoUrl: string | null;
  isPinned: boolean;
  vector: Float32Array; // source of truth; backends that ship to a
  tagsVector: Float32Array | null; // remote ANN may also skip the blob column
}

export interface ListOptions {
  containerTag?: string; // "" means all
  limit?: number;
  sessionId?: string; // backend-indexed
}

export interface RecordStore {
  init(): Promise<void>; // runs migrations, opens pool
  close(): Promise<void>;

  insert(scope: ScopeKey, row: MemoryRow): Promise<void>;
  update(scope: ScopeKey, id: string, patch: Partial<MemoryRow>): Promise<void>;
  delete(scope: ScopeKey, id: string): Promise<void>;
  getById(scope: ScopeKey, id: string): Promise<MemoryRow | null>;

  list(scope: ScopeKey, opts: ListOptions): Promise<MemoryRow[]>;
  countByContainer(scope: ScopeKey, containerTag: string): Promise<number>;
  countAll(scope: ScopeKey): Promise<number>;
  distinctTags(scope: ScopeKey): Promise<TagsRow[]>;

  getByIds(scope: ScopeKey, ids: string[], containerTag: string): Promise<MemoryRow[]>;
  iterateVectors(
    scope: ScopeKey,
    kind: "content" | "tags"
  ): AsyncIterable<{ id: string; vector: Float32Array }>;

  setPinned(scope: ScopeKey, id: string, pinned: boolean): Promise<void>;
  listScopes(scope: "user" | "project"): Promise<ScopeKey[]>;
}
```

### Design rationale

- **Vectors live on the row.** Mirrors today's SQLite blob model and keeps a single
  source of truth even when the `VectorBackend` is remote. `iterateVectors` exists so
  ANN rebuilds don't buffer all vectors.
- **No transactions in the interface.** Current code performs one row per call and runs
  dedup as a non-transactional batch. Adding transactions complicates every backend for
  a feature we don't need. If needed later, it goes in as a `Transactional` capability
  interface.
- **`ScopeKey` on every method.** Multi-tenancy is now first-class. No method accepts an
  open DB handle — that was SQLite leaking into consumers.
- **`iterateVectors` is an `AsyncIterable`.** Lets USearch stream during rebuild; SQLite
  yields from prepared statements, Postgres uses cursored reads.
- **Methods that disappear:** `vectorSearch.getMemoriesBySessionID` → `list({sessionId})`.
  `rebuildIndexForShard` disappears entirely — `VectorBackend` now accepts an
  `AsyncIterable<{id, vector}>` instead of a DB handle.

## `VectorBackend` interface (generalized)

```ts
export type VectorKind = "content" | "tags";

export interface NamespaceKey {
  scope: "user" | "project";
  scopeHash: string;
  shardIndex?: number; // SQLite-only; remote backends ignore
}

export interface VectorBackend {
  getBackendName(): string;

  insert(args: {
    id: string;
    vector: Float32Array;
    ns: NamespaceKey;
    kind: VectorKind;
  }): Promise<void>;
  insertBatch(args: {
    items: { id: string; vector: Float32Array }[];
    ns: NamespaceKey;
    kind: VectorKind;
  }): Promise<void>;
  delete(args: { id: string; ns: NamespaceKey; kind: VectorKind }): Promise<void>;

  search(args: {
    ns: NamespaceKey;
    kind: VectorKind;
    queryVector: Float32Array;
    limit: number;
  }): Promise<{ id: string; distance: number }[]>;

  rebuildFromSource(args: {
    ns: NamespaceKey;
    kind: VectorKind;
    source: AsyncIterable<{ id: string; vector: Float32Array }>;
  }): Promise<void>;

  dropNamespace(args: { ns: NamespaceKey }): Promise<void>;
}
```

Key change vs current: `rebuildFromShard(db, shard, kind)` → `rebuildFromSource(ns, kind, source)`.
The caller (`MemoryStore`) fetches the iterable from `recordStore.iterateVectors(...)` and
passes it in. `ShardInfo` is no longer part of the public interface; `shardIndex` is an
optional field on `NamespaceKey` used only by `USearchBackend` when paired with
`SqliteRecordStore`.

### `PgvectorBackend` (PR #3)

Single-table backend keyed by `(memory_id, kind)` with an HNSW index using
`vector_cosine_ops`. `rebuildFromSource` is a no-op (state lives in the DB); it MAY
optionally verify the count matches the source. `delete` is a no-op when the paired
`PostgresRecordStore` uses `ON DELETE CASCADE` on `memory_vectors.memory_id`.

### Pairing matrix (validated by `factory.ts`)

| RecordStore | VectorBackend      | Vector storage                         |
| ----------- | ------------------ | -------------------------------------- |
| SQLite      | USearch (default)  | Blob in `memories` table, in-proc HNSW |
| SQLite      | ExactScan          | Blob in `memories`, no ANN             |
| Postgres    | Pgvector (default) | `memory_vectors` table, server HNSW    |
| Postgres    | USearch            | Blob in `memories`, per-agent HNSW     |
| Postgres    | ExactScan          | Blob in `memories`, no ANN             |
| libSQL      | USearch (default)  | Blob in `memories`, per-agent HNSW     |
| libSQL      | ExactScan          | Blob in `memories`, no ANN             |

Invalid pairings (e.g. Pgvector with non-Postgres recordStore) throw on `factory.ts` with
a clear message. Unknown extension at Postgres init falls back to USearch with a log.

## Schema

### Postgres (PR #2)

```sql
CREATE TABLE memories (
  id            TEXT PRIMARY KEY,
  scope         TEXT NOT NULL,                    -- 'user' | 'project'
  scope_hash    TEXT NOT NULL,
  container_tag TEXT NOT NULL,
  content       TEXT NOT NULL,
  tags          TEXT,                              -- comma-joined; mirrors SQLite
  type          TEXT,
  metadata      JSONB,
  display_name  TEXT,
  user_name     TEXT,
  user_email    TEXT,
  project_path  TEXT,
  project_name  TEXT,
  git_repo_url  TEXT,
  is_pinned     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    BIGINT NOT NULL,                   -- Date.now() ms
  updated_at    BIGINT NOT NULL,
  vector_bytes      BYTEA,                          -- NULL when paired with Pgvector
  tags_vector_bytes BYTEA
);

CREATE INDEX idx_memories_scope     ON memories(scope, scope_hash);
CREATE INDEX idx_memories_container ON memories(scope, scope_hash, container_tag);
CREATE INDEX idx_memories_type      ON memories(scope, scope_hash, type);
CREATE INDEX idx_memories_created   ON memories(created_at DESC);
CREATE INDEX idx_memories_pinned    ON memories(scope, scope_hash, is_pinned) WHERE is_pinned;
CREATE INDEX idx_memories_session   ON memories ((metadata->>'sessionID'));
```

### Postgres + Pgvector (PR #3)

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE memory_vectors (
  memory_id   TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                       -- 'content' | 'tags'
  embedding   vector(${EMBEDDING_DIMS}) NOT NULL,   -- substituted from CONFIG.embeddingDimensions at migration time
  scope       TEXT NOT NULL,
  scope_hash  TEXT NOT NULL,
  PRIMARY KEY (memory_id, kind)
);

CREATE INDEX idx_vectors_ann
  ON memory_vectors USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX idx_vectors_ns ON memory_vectors(scope, scope_hash, kind);
```

When `PgvectorBackend` is active, `PostgresRecordStore` writes `NULL` into
`vector_bytes` / `tags_vector_bytes` (the columns remain in the schema so the same
deployment can swap to USearch without a schema migration).

### libSQL (PR #2)

Same shape as Postgres with these substitutions:

- `BYTEA` → `BLOB`
- `JSONB` → `TEXT` (parsed at the `RecordStore` boundary)
- `BOOLEAN` → `INTEGER 0/1`
- Functional `idx_memories_session` on `metadata->>'sessionID'` → an explicit
  `session_id TEXT` column populated at insert time, with a plain index. The
  Postgres path can do the same for consistency if we find functional-index quirks
  in operators; spec'd as functional for now.

### SQLite (unchanged on disk)

Existing sharded files, schema defined in `shard-manager.initShardDb()`. The
`SqliteRecordStore` is a 1:1 wrapper. No data migration for existing users.

### Migrations

Kysely migrations live under `src/services/storage/migrations/kysely-migrations/<dialect>/`.
`RecordStore.init()` runs pending migrations. The migrations metadata table is
dialect-standard Kysely. SQLite is exempt (uses its existing in-place ALTERs in
`connection-manager.migrateSchema`).

## Configuration

```ts
storage: {
  recordStore:
    | { kind: "sqlite" }                                              // default
    | { kind: "postgres"; url: string; ssl?: boolean; poolSize?: number }
    | { kind: "libsql";   url: string; authToken?: string },

  vectorBackend:
    | { kind: "usearch" }
    | { kind: "exact-scan" }
    | { kind: "pgvector" },
};
```

- Defaults: `recordStore.kind = "sqlite"`, `vectorBackend.kind = "usearch"`. Existing
  installs that don't add a `storage` block see zero change.
- All URLs and tokens pass through the existing `secret-resolver.ts`
  (`${secret:DATABASE_URL}` resolves at load).
- `factory.ts` validates pairings per the matrix; defaults `vectorBackend` per
  `recordStore` when omitted (`sqlite → usearch`, `postgres → pgvector` if extension
  available else `usearch`, `libsql → usearch`).
- Plugin hot-reload: `plugin.ts` closes the previous `MemoryStore` and constructs a new
  one when config changes.

## Migration CLI

`bin/migrate.ts` exposed via `package.json` `bin: { "opencode-mem-migrate": "dist/migrate.js" }`.

```
opencode-mem-migrate \
  --to postgres \
  --url "postgres://..." \
  --vector-backend pgvector \
  [--dry-run] [--batch-size 500] [--scope user|project|all] [--resume]
```

- Streams from `SqliteRecordStore.iterateAllRows()` — a CLI-only addition behind a
  `Migratable` capability interface so it doesn't pollute the main `RecordStore` API.
- Uses `INSERT ... ON CONFLICT (id) DO NOTHING` so re-runs are safe and resumable.
- When target vector backend is `pgvector`, also writes `memory_vectors` from the
  blobs streamed from SQLite.
- Prints progress; exits non-zero on any per-row failure with a tally.
- No reverse migration in v1 (remote → local). Documented as a non-goal.

## Reference deployment (PR #3)

Three artifacts in `examples/`:

- **`examples/docker-compose.example.yml`** — opencode + Postgres+pgvector, single-host.
  A one-shot init service runs migrations before the agent starts.
- **`examples/supervisord/supervisord.example.conf`** — mirrors the slack-bot pattern
  (`config-manager` → readiness file → `opencode`), adds an optional `qdrant` sidecar
  program for users who pair `PostgresRecordStore + USearchBackend` (or future Qdrant
  backend), and a `migrate` one-shot program with `autostart=true, autorestart=false,
exitcodes=0` for first-boot remote setup.
- **`examples/README.md`** — matrix: single-host vs distributed, when to pick which
  `VectorBackend`, how to point multiple agent containers at one Postgres.

## Testing strategy

- **Per-backend unit tests** (`postgres-record-store.test.ts`, etc.) using testcontainers
  for Postgres and `:memory:` for libSQL/SQLite.
- **Contract test suite** — one set of assertions parameterized over every `RecordStore`
  implementation (`it.each([sqliteFactory, postgresFactory, libsqlFactory])`). This is
  the core proof that the abstraction holds.
- **Pairing tests** — for each valid `(RecordStore, VectorBackend)` pair from the
  matrix, an end-to-end "insert → search → delete" test.
- **Migration test** — seed an SQLite DB, run the CLI against testcontainer Postgres,
  assert counts and search results match.
- **Existing tests** continue to pass unchanged (SQLite default path is preserved).

## Stacked-branch PR plan

The work is staged so each PR is reviewable in isolation but the entire chain can be
implemented continuously without waiting for upstream review between steps. Each branch
is created off the previous one; PRs are opened against the previous branch (then
retargeted to `main` as each ancestor lands).

```
main
 └─ feat/storage-abstraction              PR #1 → main
     └─ feat/postgres-libsql-backends     PR #2 → feat/storage-abstraction
         └─ feat/pgvector-deployment      PR #3 → feat/postgres-libsql-backends
```

### PR #1 — `feat/storage-abstraction` (pure refactor)

- Introduce `RecordStore` / `VectorBackend` (generalized) / `MemoryStore` interfaces.
- Wrap existing SQLite code in `SqliteRecordStore` with no behavior changes.
- Migrate all consumers to import `MemoryStore` only.
- Async-ify every chain that touches the store.
- **No new dependencies, no new tests beyond existing ones passing unchanged.**
- Existing test suite passes byte-identically. This is the upstream-acceptance gate.

### PR #2 — `feat/postgres-libsql-backends` (branched off PR #1)

- Add deps: `kysely`, `pg`, `@libsql/client`.
- `PostgresRecordStore`, `LibsqlRecordStore`, Kysely migrations.
- `bin/migrate.ts` (SQLite → remote one-shot).
- Contract test suite + pairing tests for `(Postgres|libSQL) × (USearch|ExactScan)`.
- Testcontainers in CI.
- Default config still selects SQLite; remote is opt-in.

### PR #3 — `feat/pgvector-deployment` (branched off PR #2)

- `PgvectorBackend` (`VectorBackend` impl against `memory_vectors`).
- Postgres+Pgvector pairing test.
- `examples/docker-compose.example.yml`, `examples/supervisord/`, `examples/README.md`.

### Local development workflow

Branch chain is created up-front:

```
git checkout -b feat/storage-abstraction
# ... implement PR #1 ...
git checkout -b feat/postgres-libsql-backends
# ... implement PR #2 ...
git checkout -b feat/pgvector-deployment
# ... implement PR #3 ...
```

When PR #1 lands on `main`, rebase #2 onto `main`; same for #3 once #2 lands.
`git rebase --update-refs` keeps the chain consistent through interactive rebases.

## Open risks

- **Async-migration scope (PR #1).** Touching ~10 service files mechanically — the risk
  is a missed `await` causing subtle ordering bugs. Mitigation: lean on the existing
  test suite and add an `eslint-plugin-no-floating-promises` rule in PR #1.
- **`metadata` JSON-vs-TEXT divergence.** Postgres queries on
  `metadata->>'sessionID'` use the JSONB operator; SQLite does substring matching today.
  The `RecordStore` boundary normalizes — but the `sessionId` path on SQLite continues
  to use the legacy `LIKE` scan and is therefore slow. Acceptable since SQLite is
  single-process and the row counts are small.
- **Connection-pool sizing on Postgres.** Each agent container holds a pool. With many
  containers, total connections × pool_size can exhaust the DB. Default `poolSize = 4`
  with a config knob; document in `examples/README.md`.
- **pgvector extension availability on managed services.** RDS supports it; Aurora
  Serverless v2 does too (recent). If unavailable, fall back to USearch with a log line
  (already specified in the factory).

## Out of scope (explicit non-deliverables)

- Multi-region replication.
- Reverse migration (remote → local).
- Hot-swap of vector backend at runtime (requires restart).
- Schema management UI / admin commands beyond the migrate CLI.
- Backup / restore tooling (use the DB's native tools).
