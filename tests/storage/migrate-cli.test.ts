import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("migrate CLI copies all rows from SQLite to Postgres", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocmem-mig-"));
  const { SqliteRecordStore } =
    await import("../../src/services/storage/record-stores/sqlite-record-store.ts");
  const src = new SqliteRecordStore({ storagePath: dir, embeddingDimensions: 4 });
  await src.init();

  // Seed 5 rows across two scopes.
  const rows = (id: string, scopeHash: string) => ({
    scope: { scope: "user" as const, scopeHash },
    row: {
      id,
      content: `content-${id}`,
      containerTag: "opencode-user",
      tags: ["alpha", "beta"],
      type: null,
      createdAt: 1000,
      updatedAt: 1000,
      metadata: { sessionID: `sess-${id}` },
      displayName: null,
      userName: null,
      userEmail: null,
      projectPath: null,
      projectName: null,
      gitRepoUrl: null,
      isPinned: false,
      vector: new Float32Array([1, 0, 0, 0]),
      tagsVector: null,
    },
  });
  for (const [id, h] of [
    ["m1", "h1"],
    ["m2", "h1"],
    ["m3", "h2"],
    ["m4", "h2"],
    ["m5", "h2"],
  ]) {
    const r = rows(id, h);
    await src.insert(r.scope, r.row as any);
  }

  const { startPostgres } = await import("./testcontainer-helpers.ts");
  const pg = await startPostgres();

  const { runMigrate } = await import("../../src/services/storage/migrate-cli.ts");
  await runMigrate({
    to: "postgres",
    url: pg.url,
    vectorBackend: "exact-scan",
    batchSize: 2,
    dryRun: false,
    scope: "all",
    resume: false,
    source: src,
    ssl: false,
  });

  const { PostgresRecordStore } =
    await import("../../src/services/storage/record-stores/postgres-record-store.ts");
  const dst = new PostgresRecordStore({ url: pg.url, ssl: false });
  await dst.init();

  const userScopes = await dst.listScopes("user");
  expect(userScopes.map((s) => s.scopeHash).sort()).toEqual(["h1", "h2"]);
  expect(await dst.countAll({ scope: "user", scopeHash: "h1" })).toBe(2);
  expect(await dst.countAll({ scope: "user", scopeHash: "h2" })).toBe(3);
  const sample = await dst.getById({ scope: "user", scopeHash: "h1" }, "m1");
  expect(sample!.content).toBe("content-m1");
  expect(Array.from(sample!.vector)).toEqual([1, 0, 0, 0]);

  await src.close();
  await dst.close();
  await pg.stop();
  rmSync(dir, { recursive: true, force: true });
}, 90000);

test("migrate CLI back-fills memory_vectors when --vector-backend pgvector", async () => {
  process.env.OPENCODE_MEM_EMBEDDING_DIMS = "4"; // must precede target.init()
  const dir = mkdtempSync(join(tmpdir(), "ocmem-mig-pgv-"));
  const { SqliteRecordStore } =
    await import("../../src/services/storage/record-stores/sqlite-record-store.ts");
  const src = new SqliteRecordStore({ storagePath: dir, embeddingDimensions: 4 });
  await src.init();

  const makeRow = (id: string, vec: number[], tagsVec: number[] | null) => ({
    scope: { scope: "user" as const, scopeHash: "h1" },
    row: {
      id,
      content: `c-${id}`,
      containerTag: "ct",
      tags: null,
      type: null,
      createdAt: 1,
      updatedAt: 1,
      metadata: null,
      displayName: null,
      userName: null,
      userEmail: null,
      projectPath: null,
      projectName: null,
      gitRepoUrl: null,
      isPinned: false,
      vector: new Float32Array(vec),
      tagsVector: tagsVec ? new Float32Array(tagsVec) : null,
    },
  });

  const rowsToInsert = [
    makeRow("m1", [1, 0, 0, 0], null),
    makeRow("m2", [0, 1, 0, 0], [0.5, 0.5, 0, 0]),
  ];
  for (const r of rowsToInsert) await src.insert(r.scope, r.row as any);

  const { startPostgresWithVector } = await import("./testcontainer-helpers.ts");
  const pg = await startPostgresWithVector();

  const { runMigrate } = await import("../../src/services/storage/migrate-cli.ts");
  const summary = await runMigrate({
    to: "postgres",
    url: pg.url,
    vectorBackend: "pgvector",
    batchSize: 2,
    dryRun: false,
    scope: "all",
    resume: false,
    source: src,
    ssl: false,
  });

  expect(summary.inserted).toBe(2);
  expect(summary.failed).toBe(0);

  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: pg.url });
  const mv = await pool.query<{ memory_id: string; kind: string }>(
    "SELECT memory_id, kind FROM memory_vectors ORDER BY memory_id, kind"
  );
  expect(mv.rowCount).toBe(3);
  expect(mv.rows.map((r) => `${r.memory_id}:${r.kind}`).sort()).toEqual([
    "m1:content",
    "m2:content",
    "m2:tags",
  ]);

  const raw = await pool.query(
    "SELECT vector_bytes, tags_vector_bytes FROM memories WHERE id = 'm2'"
  );
  expect(raw.rows[0].vector_bytes).toBeNull();
  expect(raw.rows[0].tags_vector_bytes).toBeNull();

  await pool.end();
  await src.close();
  await pg.stop();
  rmSync(dir, { recursive: true, force: true });
}, 120000);
