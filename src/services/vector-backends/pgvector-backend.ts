import type { Pool } from "pg";
import { log } from "../logger.js";
import type {
  BackendInsertItem,
  BackendSearchResult,
  NamespaceKey,
  VectorBackend,
  VectorKind,
} from "./types.js";

interface Options {
  pool: Pool;
  dimensions: number;
}

function vectorToPgvectorLiteral(v: Float32Array): string {
  // pgvector accepts the textual format: '[1,2,3]'
  let s = "[";
  for (let i = 0; i < v.length; i++) {
    if (i > 0) s += ",";
    s += (v[i] as number).toString();
  }
  return s + "]";
}

export class PgvectorBackend implements VectorBackend {
  constructor(private readonly opts: Options) {}

  async init(): Promise<void> {
    // The Kysely migration in PostgresRecordStore.init() already creates the schema.
    // This init() is a sanity probe.
    const r = await this.opts.pool.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
    if (r.rowCount === 0) throw new Error("pgvector extension is not installed in the target DB");
    if (process.env.OPENCODE_MEM_DEBUG_EXPLAIN === "true") {
      const dims = this.opts.dimensions;
      const planRows = await this.opts.pool.query(
        `EXPLAIN ANALYZE SELECT memory_id
           FROM memory_vectors
           WHERE scope = ANY($1) AND kind = $2
           ORDER BY embedding <=> $3::vector LIMIT 10`,
        [["__nonexistent__"], "content", vectorToPgvectorLiteral(new Float32Array(dims))]
      );
      log("[pgvector] scope-filter EXPLAIN", { rows: planRows.rows });
    }
  }

  getBackendName(): string {
    return "pgvector";
  }

  async insert(args: {
    id: string;
    vector: Float32Array;
    ns: NamespaceKey;
    kind: VectorKind;
  }): Promise<void> {
    await this.opts.pool.query(
      `INSERT INTO memory_vectors (memory_id, kind, embedding, scope, scope_hash)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (memory_id, kind) DO UPDATE SET embedding = EXCLUDED.embedding`,
      [args.id, args.kind, vectorToPgvectorLiteral(args.vector), args.ns.scope, args.ns.scopeHash]
    );
  }

  async insertBatch(args: {
    items: BackendInsertItem[];
    ns: NamespaceKey;
    kind: VectorKind;
  }): Promise<void> {
    if (args.items.length === 0) return;
    const values: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    for (const item of args.items) {
      values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(
        item.id,
        args.kind,
        vectorToPgvectorLiteral(item.vector),
        args.ns.scope,
        args.ns.scopeHash
      );
    }
    await this.opts.pool.query(
      `INSERT INTO memory_vectors (memory_id, kind, embedding, scope, scope_hash)
       VALUES ${values.join(", ")}
       ON CONFLICT (memory_id, kind) DO UPDATE SET embedding = EXCLUDED.embedding`,
      params
    );
  }

  async delete(_args: { id: string; ns: NamespaceKey; kind: VectorKind }): Promise<void> {
    // No-op: memory_vectors.memory_id REFERENCES memories(id) ON DELETE CASCADE.
  }

  async search(args: {
    scopes: string[];
    kind: VectorKind;
    queryVector: Float32Array;
    limit: number;
  }): Promise<BackendSearchResult[]> {
    if (!args.scopes || args.scopes.length === 0) return [];
    const literal = vectorToPgvectorLiteral(args.queryVector);
    const r = await this.opts.pool.query<{ id: string; d: number }>(
      `SELECT memory_id AS id, embedding <=> $1::vector AS d
       FROM memory_vectors
       WHERE scope = ANY($2) AND kind = $3
       ORDER BY embedding <=> $1::vector
       LIMIT $4`,
      [literal, args.scopes, args.kind, args.limit]
    );
    return r.rows.map((row) => ({ id: row.id, distance: Number(row.d) }));
  }

  async rebuildFromSource(args: {
    ns: NamespaceKey;
    kind: VectorKind;
    source: AsyncIterable<{ id: string; vector: Float32Array }>;
  }): Promise<void> {
    // No-op: state lives in the DB. The MemoryStore search path calls this once per search
    // — that's intentional from the abstraction, but here it should cost nothing.
    if (process.env.OPENCODE_MEM_PGVECTOR_VERIFY === "1") {
      let sourceCount = 0;
      for await (const _row of args.source) sourceCount++;
      const r = await this.opts.pool.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM memory_vectors
         WHERE scope = $1 AND scope_hash = $2 AND kind = $3`,
        [args.ns.scope, args.ns.scopeHash, args.kind]
      );
      const dbCount = Number(r.rows[0]?.c ?? 0);
      if (dbCount !== sourceCount) {
        log("PgvectorBackend rebuild detected divergence", {
          sourceCount,
          dbCount,
          ns: args.ns,
          kind: args.kind,
        });
      }
    }
  }

  async dropNamespace(args: { ns: NamespaceKey }): Promise<void> {
    await this.opts.pool.query(`DELETE FROM memory_vectors WHERE scope = $1 AND scope_hash = $2`, [
      args.ns.scope,
      args.ns.scopeHash,
    ]);
  }
}
