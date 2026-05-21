import { Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // Set by bootstrap.ts before migrateToLatest; falls back to 768 if migration is run outside bootstrap.
  // Read at up() time (not module top-level) so test-time env mutations are honored.
  const DIMS = Number(process.env.OPENCODE_MEM_EMBEDDING_DIMS ?? "768");
  await sql`CREATE EXTENSION IF NOT EXISTS vector`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS memory_vectors (
      memory_id   TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL,
      embedding   vector(${sql.raw(String(Number(DIMS)))}) NOT NULL,
      scope       TEXT NOT NULL,
      scope_hash  TEXT NOT NULL,
      PRIMARY KEY (memory_id, kind)
    )
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_vectors_ann
      ON memory_vectors USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64)
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_vectors_ns
      ON memory_vectors(scope, scope_hash, kind)
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_vectors_ann`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_vectors_ns`.execute(db);
  await sql`DROP TABLE IF EXISTS memory_vectors`.execute(db);
}
