// tests/storage/pairing.test.ts
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/services/storage/memory-store.ts";
import { LibsqlRecordStore } from "../../src/services/storage/record-stores/libsql-record-store.ts";
import { PostgresRecordStore } from "../../src/services/storage/record-stores/postgres-record-store.ts";
import { SqliteRecordStore } from "../../src/services/storage/record-stores/sqlite-record-store.ts";
import type { MemoryRow, ScopeKey } from "../../src/services/storage/types.ts";
import { ExactScanBackend } from "../../src/services/vector-backends/exact-scan-backend.ts";
import { startPostgres } from "./testcontainer-helpers.ts";

// Inserts a row with vector [1,0,0,0], searches for [1,0,0,0],
// expects top-1 to be that row, then deletes it.
async function runPair(store: MemoryStore, scope: ScopeKey): Promise<void> {
  const row: MemoryRow = {
    id: "test-1",
    content: "hello",
    containerTag: "opencode-user",
    tags: ["x"],
    type: null,
    createdAt: 1000,
    updatedAt: 1000,
    metadata: null,
    displayName: null,
    userName: null,
    userEmail: null,
    projectPath: null,
    projectName: null,
    gitRepoUrl: null,
    isPinned: false,
    vector: new Float32Array([1, 0, 0, 0]),
    tagsVector: null,
  };
  await store.insert(scope, row);
  const results = await store.search(scope, new Float32Array([1, 0, 0, 0]), "", 10, 0.5);
  expect(results.length).toBeGreaterThan(0);
  expect(results[0].id).toBe("test-1");
  await store.delete(scope, "test-1");
  expect(await store.getById(scope, "test-1")).toBeNull();
}

// SQLite + ExactScan
test("sqlite + exact-scan", async () => {
  const sqliteDir = mkdtempSync(join(tmpdir(), "ocmem-pair-sqlite-"));
  const rs = new SqliteRecordStore({ storagePath: sqliteDir, embeddingDimensions: 4 });
  await rs.init();
  const vb = new ExactScanBackend();
  const store = new MemoryStore(rs, vb);
  try {
    await runPair(store, { scope: "user", scopeHash: "h" });
  } finally {
    await rs.close();
    rmSync(sqliteDir, { recursive: true, force: true });
  }
});

// libSQL + ExactScan
test("libsql + exact-scan", async () => {
  const rs = new LibsqlRecordStore({ url: ":memory:" });
  await rs.init();
  const vb = new ExactScanBackend();
  const store = new MemoryStore(rs, vb);
  try {
    await runPair(store, { scope: "user", scopeHash: "h" });
  } finally {
    await rs.close();
  }
});

// Postgres + ExactScan (testcontainer)
test("postgres + exact-scan", async () => {
  const pg = await startPostgres();
  const rs = new PostgresRecordStore({ url: pg.url, ssl: false, poolSize: 2 });
  await rs.init();
  const vb = new ExactScanBackend();
  const store = new MemoryStore(rs, vb);
  try {
    await runPair(store, { scope: "user", scopeHash: "h" });
  } finally {
    await rs.close();
    await pg.stop();
  }
});
