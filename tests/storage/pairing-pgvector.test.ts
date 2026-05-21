// tests/storage/pairing-pgvector.test.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { MemoryStore } from "../../src/services/storage/memory-store.ts";
import { PostgresRecordStore } from "../../src/services/storage/record-stores/postgres-record-store.ts";
import type { MemoryRow } from "../../src/services/storage/types.ts";
import { PgvectorBackend } from "../../src/services/vector-backends/pgvector-backend.ts";
import { startPostgresWithVector } from "./testcontainer-helpers.ts";

let stopContainer: () => Promise<void>;
let rs: PostgresRecordStore;
let store: MemoryStore;

beforeAll(async () => {
  // Must precede rs.init() so the migration creates memory_vectors.embedding as vector(4).
  process.env.OPENCODE_MEM_EMBEDDING_DIMS = "4";
  const pg = await startPostgresWithVector();
  stopContainer = pg.stop;
  rs = new PostgresRecordStore({ url: pg.url, ssl: false, omitVectorBytes: true });
  await rs.init();
  const vb = new PgvectorBackend({ pool: rs.getPool(), dimensions: 4 });
  await vb.init();
  store = new MemoryStore(rs, vb);
});

afterAll(async () => {
  await store.close();
  await stopContainer();
});

function makeRow(id: string, vec: number[]): MemoryRow {
  return {
    id,
    content: id,
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
    tagsVector: null,
  };
}

test("Postgres + Pgvector: insert → search → cascade-delete + vector_bytes NULL invariant", async () => {
  const scope = { scope: "user" as const, scopeHash: "h1" };

  await store.insert(scope, makeRow("a", [1, 0, 0, 0]));
  await store.insert(scope, makeRow("b", [0, 1, 0, 0]));
  await store.insert(scope, makeRow("c", [0, 0, 1, 0]));

  const results = await store.search(scope, new Float32Array([0.99, 0.01, 0, 0]), "", 3, 0);
  expect(results.length).toBeGreaterThan(0);
  expect(results[0].id).toBe("a");

  // vector_bytes invariant: paired-backend writes NULL.
  const raw = await rs.getPool().query("SELECT vector_bytes FROM memories WHERE id = 'a'");
  expect(raw.rows[0].vector_bytes).toBeNull();

  // Cascade: deleting via MemoryStore removes the memories row AND the memory_vectors row.
  await store.delete(scope, "a");
  const after = await rs.getPool().query("SELECT 1 FROM memory_vectors WHERE memory_id = 'a'");
  expect(after.rowCount).toBe(0);
});
