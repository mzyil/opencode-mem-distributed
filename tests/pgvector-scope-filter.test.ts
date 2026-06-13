// tests/pgvector-scope-filter.test.ts
//
// Integration test: verifies that the pgvector backend isolates results by scope
// using WHERE scope = ANY($1::text[]) before applying HNSW cosine ordering.
//
// Gated by RUN_PGVECTOR_TESTS=true so default CI runs stay hermetic.
// Run manually:
//   npm run test:integration
//
// Requires Docker on the host and the fixtures/docker-compose.pgvector.yml file.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { Pool } from "pg";
import { PgvectorBackend } from "../src/services/vector-backends/pgvector-backend.js";

const SHOULD_RUN = process.env.RUN_PGVECTOR_TESTS === "true";

const COMPOSE_FILE = new URL("./fixtures/docker-compose.pgvector.yml", import.meta.url).pathname;

describe.runIf(SHOULD_RUN)("pgvector scope filter", () => {
  let pool: Pool;
  let backend: PgvectorBackend;
  const DIMS = 768;

  beforeAll(async () => {
    execSync(`docker compose -f ${COMPOSE_FILE} up -d --wait`, { stdio: "inherit" });
    pool = new Pool({ connectionString: "postgres://postgres:testpass@localhost:55432/memtest" });
    await pool.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await pool.query(
      `CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, content TEXT, scope TEXT)`
    );
    await pool.query(`CREATE TABLE IF NOT EXISTS memory_vectors (
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      embedding vector(${DIMS}) NOT NULL,
      scope TEXT NOT NULL,
      scope_hash TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (memory_id, kind)
    )`);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_vectors_ns ON memory_vectors(scope, scope_hash, kind)`
    );
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_vectors_ann
      ON memory_vectors USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)`);
    backend = new PgvectorBackend({ pool, dimensions: DIMS });
    await backend.init();
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    execSync(`docker compose -f ${COMPOSE_FILE} down -v`, { stdio: "inherit" });
  });

  it("isolates scopes under HNSW search", async () => {
    const v = new Float32Array(DIMS).fill(0.1);
    const rows: Array<[string, string, string]> = [
      ["1", "qna:user:U1", "alpha"],
      ["2", "qna:user:U2", "beta"],
      ["3", "qna:org", "gamma"],
      ["4", "code:user:U1", "delta"],
    ];
    for (const [id, scope, content] of rows) {
      await pool.query(`INSERT INTO memories(id, content, scope) VALUES ($1, $2, $3)`, [
        id,
        content,
        scope,
      ]);
      await backend.insert({ id, vector: v, ns: { scope, scopeHash: "" }, kind: "content" });
    }

    // Only rows in qna:user:U1 should be returned
    const u1 = await backend.search({
      scopes: ["qna:user:U1"],
      kind: "content",
      queryVector: v,
      limit: 10,
    });
    expect(u1.map((r) => r.id).sort()).toEqual(["1"]);

    // Rows in qna:user:U1 OR qna:org should be returned
    const u1AndOrg = await backend.search({
      scopes: ["qna:user:U1", "qna:org"],
      kind: "content",
      queryVector: v,
      limit: 10,
    });
    expect(u1AndOrg.map((r) => r.id).sort()).toEqual(["1", "3"]);

    // Empty scopes array returns no results (defensive default)
    const empty = await backend.search({
      scopes: [],
      kind: "content",
      queryVector: v,
      limit: 10,
    });
    expect(empty).toEqual([]);
  });

  it("peer domain rows are NOT included unless their scope is listed", async () => {
    const v = new Float32Array(DIMS).fill(0.2);
    const rows: Array<[string, string, string]> = [
      ["10", "qna:user:U3", "qna-row"],
      ["11", "code:user:U3", "code-row"],
    ];
    for (const [id, scope, content] of rows) {
      await pool.query(`INSERT INTO memories(id, content, scope) VALUES ($1, $2, $3)`, [
        id,
        content,
        scope,
      ]);
      await backend.insert({ id, vector: v, ns: { scope, scopeHash: "" }, kind: "content" });
    }

    const qnaOnly = await backend.search({
      scopes: ["qna:user:U3"],
      kind: "content",
      queryVector: v,
      limit: 10,
    });
    expect(qnaOnly.map((r) => r.id)).toEqual(["10"]);

    const both = await backend.search({
      scopes: ["qna:user:U3", "code:user:U3"],
      kind: "content",
      queryVector: v,
      limit: 10,
    });
    expect(both.map((r) => r.id).sort()).toEqual(["10", "11"]);
  });
});
