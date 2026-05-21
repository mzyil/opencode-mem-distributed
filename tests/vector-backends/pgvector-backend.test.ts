import { afterAll, beforeAll, expect, test } from "bun:test";
import { Pool } from "pg";
import { PostgresRecordStore } from "../../src/services/storage/record-stores/postgres-record-store.ts";
import { startPostgresWithVector } from "../storage/testcontainer-helpers.ts";

let stop: () => Promise<void>;
let pool: Pool;
let rs: PostgresRecordStore;

beforeAll(async () => {
  process.env.OPENCODE_MEM_EMBEDDING_DIMS = "4"; // must precede rs.init()
  const pg = await startPostgresWithVector();
  stop = pg.stop;
  rs = new PostgresRecordStore({ url: pg.url, ssl: false });
  await rs.init();
  pool = new Pool({ connectionString: pg.url, max: 2 });
});

afterAll(async () => {
  await rs.close();
  await pool.end();
  await stop();
});

function makeRow(id: string, vec: number[]) {
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

test("pgvector insert + search returns nearest neighbor", async () => {
  const { PgvectorBackend } =
    await import("../../src/services/vector-backends/pgvector-backend.ts");
  const vb = new PgvectorBackend({ pool, dimensions: 4 });
  await vb.init();
  const ns = { scope: "user" as const, scopeHash: "h1" };
  await rs.insert(ns, makeRow("m1", [1, 0, 0, 0]));
  await vb.insert({
    id: "m1",
    vector: new Float32Array([1, 0, 0, 0]),
    ns,
    kind: "content",
  });
  const got = await vb.search({
    ns,
    kind: "content",
    queryVector: new Float32Array([0.99, 0.01, 0, 0]),
    limit: 1,
  });
  expect(got.length).toBe(1);
  expect(got[0].id).toBe("m1");
});

test("pgvector delete cascade fires on memories delete", async () => {
  const { PgvectorBackend } =
    await import("../../src/services/vector-backends/pgvector-backend.ts");
  const vb = new PgvectorBackend({ pool, dimensions: 4 });
  await vb.init();
  const ns = { scope: "user" as const, scopeHash: "h2" };
  await rs.insert(ns, makeRow("m2", [0, 1, 0, 0]));
  await vb.insert({
    id: "m2",
    vector: new Float32Array([0, 1, 0, 0]),
    ns,
    kind: "content",
  });
  let got = await vb.search({
    ns,
    kind: "content",
    queryVector: new Float32Array([0, 1, 0, 0]),
    limit: 1,
  });
  expect(got[0]?.id).toBe("m2");
  await rs.delete(ns, "m2");
  got = await vb.search({
    ns,
    kind: "content",
    queryVector: new Float32Array([0, 1, 0, 0]),
    limit: 1,
  });
  expect(got.find((r) => r.id === "m2")).toBeUndefined();
});
