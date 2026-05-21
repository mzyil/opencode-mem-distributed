// src/services/storage/record-stores/postgres-record-store.ts
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { runMigrations } from "../migrations/bootstrap.js";
import type { ListOptions, MemoryRow, RecordStore, ScopeKey, TagsRow } from "../types.js";
import { bufferToVector, joinTags, rowFromDb, vectorToBuffer } from "./codecs.js";

interface Options {
  url: string;
  ssl?: boolean;
  poolSize?: number;
}

type Db = Kysely<any>;

export class PostgresRecordStore implements RecordStore {
  private pool!: Pool;
  private db!: Db;

  constructor(private readonly opts: Options) {}

  async init(): Promise<void> {
    this.pool = new Pool({
      connectionString: this.opts.url,
      ssl: this.opts.ssl ? { rejectUnauthorized: false } : false,
      max: this.opts.poolSize ?? 4,
    });
    this.db = new Kysely({ dialect: new PostgresDialect({ pool: this.pool }) });
    await runMigrations(this.db, "postgres");
  }

  async close(): Promise<void> {
    await this.db.destroy();
  }

  async insert(scope: ScopeKey, row: MemoryRow): Promise<void> {
    await this.db
      .insertInto("memories")
      .values({
        id: row.id,
        scope: scope.scope,
        scope_hash: scope.scopeHash,
        container_tag: row.containerTag,
        content: row.content,
        tags: joinTags(row.tags),
        type: row.type,
        metadata: row.metadata, // pg jsonb auto-serializes
        display_name: row.displayName,
        user_name: row.userName,
        user_email: row.userEmail,
        project_path: row.projectPath,
        project_name: row.projectName,
        git_repo_url: row.gitRepoUrl,
        is_pinned: row.isPinned,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
        vector_bytes: vectorToBuffer(row.vector),
        tags_vector_bytes: vectorToBuffer(row.tagsVector),
      })
      .execute();
  }

  async update(scope: ScopeKey, id: string, patch: Partial<MemoryRow>): Promise<void> {
    const set: Record<string, any> = {};
    if (patch.content !== undefined) set.content = patch.content;
    if (patch.containerTag !== undefined) set.container_tag = patch.containerTag;
    if (patch.type !== undefined) set.type = patch.type;
    if (patch.metadata !== undefined) set.metadata = patch.metadata;
    if (patch.displayName !== undefined) set.display_name = patch.displayName;
    if (patch.userName !== undefined) set.user_name = patch.userName;
    if (patch.userEmail !== undefined) set.user_email = patch.userEmail;
    if (patch.projectPath !== undefined) set.project_path = patch.projectPath;
    if (patch.projectName !== undefined) set.project_name = patch.projectName;
    if (patch.gitRepoUrl !== undefined) set.git_repo_url = patch.gitRepoUrl;
    if (patch.updatedAt !== undefined) set.updated_at = patch.updatedAt;
    if (patch.isPinned !== undefined) set.is_pinned = patch.isPinned;
    if (patch.tags !== undefined) set.tags = joinTags(patch.tags);
    if (patch.vector !== undefined) set.vector_bytes = vectorToBuffer(patch.vector);
    if ("tagsVector" in patch) {
      set.tags_vector_bytes = vectorToBuffer(patch.tagsVector ?? null);
    }
    if (Object.keys(set).length === 0) return;
    await this.db
      .updateTable("memories")
      .set(set)
      .where("id", "=", id)
      .where("scope", "=", scope.scope)
      .where("scope_hash", "=", scope.scopeHash)
      .execute();
  }

  async delete(scope: ScopeKey, id: string): Promise<void> {
    await this.db
      .deleteFrom("memories")
      .where("id", "=", id)
      .where("scope", "=", scope.scope)
      .where("scope_hash", "=", scope.scopeHash)
      .execute();
  }

  async getById(scope: ScopeKey, id: string): Promise<MemoryRow | null> {
    const r = await this.db
      .selectFrom("memories")
      .selectAll()
      .where("id", "=", id)
      .where("scope", "=", scope.scope)
      .where("scope_hash", "=", scope.scopeHash)
      .executeTakeFirst();
    return r ? rowFromDb(r, "vector_bytes", "tags_vector_bytes") : null;
  }

  async list(scope: ScopeKey, opts: ListOptions): Promise<MemoryRow[]> {
    let q = this.db
      .selectFrom("memories")
      .selectAll()
      .where("scope", "=", scope.scope)
      .where("scope_hash", "=", scope.scopeHash);
    if (opts.sessionId) {
      q = q.where(sql`metadata->>'sessionID'`, "=", opts.sessionId);
    } else if (opts.containerTag) {
      q = q.where("container_tag", "=", opts.containerTag);
    }
    q = q.orderBy("created_at", "desc");
    if (opts.limit !== undefined) q = q.limit(opts.limit);
    const rows = await q.execute();
    return rows.map((r) => rowFromDb(r, "vector_bytes", "tags_vector_bytes"));
  }

  async countByContainer(scope: ScopeKey, containerTag: string): Promise<number> {
    const r = await this.db
      .selectFrom("memories")
      .select(({ fn }) => [fn.countAll<number>().as("c")])
      .where("scope", "=", scope.scope)
      .where("scope_hash", "=", scope.scopeHash)
      .where("container_tag", "=", containerTag)
      .executeTakeFirst();
    return Number(r?.c ?? 0);
  }

  async countAll(scope: ScopeKey): Promise<number> {
    const r = await this.db
      .selectFrom("memories")
      .select(({ fn }) => [fn.countAll<number>().as("c")])
      .where("scope", "=", scope.scope)
      .where("scope_hash", "=", scope.scopeHash)
      .executeTakeFirst();
    return Number(r?.c ?? 0);
  }

  async distinctTags(scope: ScopeKey): Promise<TagsRow[]> {
    const rows = await this.db
      .selectFrom("memories")
      .select([
        "container_tag",
        "display_name",
        "user_name",
        "user_email",
        "project_path",
        "project_name",
        "git_repo_url",
      ])
      .where("scope", "=", scope.scope)
      .where("scope_hash", "=", scope.scopeHash)
      .distinct()
      .execute();
    return rows.map((r) => ({
      containerTag: r.container_tag,
      displayName: r.display_name ?? null,
      userName: r.user_name ?? null,
      userEmail: r.user_email ?? null,
      projectPath: r.project_path ?? null,
      projectName: r.project_name ?? null,
      gitRepoUrl: r.git_repo_url ?? null,
    }));
  }

  async getByIds(scope: ScopeKey, ids: string[], containerTag: string): Promise<MemoryRow[]> {
    if (ids.length === 0) return [];
    let q = this.db
      .selectFrom("memories")
      .selectAll()
      .where("scope", "=", scope.scope)
      .where("scope_hash", "=", scope.scopeHash)
      .where("id", "in", ids);
    if (containerTag !== "") q = q.where("container_tag", "=", containerTag);
    const rows = await q.execute();
    return rows.map((r) => rowFromDb(r, "vector_bytes", "tags_vector_bytes"));
  }

  iterateVectors(
    scope: ScopeKey,
    kind: "content" | "tags"
  ): AsyncIterable<{ id: string; vector: Float32Array }> {
    const col = kind === "tags" ? "tags_vector_bytes" : "vector_bytes";
    const pool = this.pool;
    const s = scope;
    // TODO(perf): swap to pg-query-stream for huge scopes
    return (async function* () {
      const client = await pool.connect();
      try {
        const res = await client.query<{ id: string; v: Buffer | null }>({
          text: `SELECT id, ${col} AS v FROM memories
                 WHERE scope=$1 AND scope_hash=$2 AND ${col} IS NOT NULL`,
          values: [s.scope, s.scopeHash],
        });
        for (const row of res.rows) {
          if (!row.v) continue;
          yield { id: row.id, vector: bufferToVector(row.v) };
        }
      } finally {
        client.release();
      }
    })();
  }

  async setPinned(scope: ScopeKey, id: string, pinned: boolean): Promise<void> {
    await this.db
      .updateTable("memories")
      .set({ is_pinned: pinned })
      .where("id", "=", id)
      .where("scope", "=", scope.scope)
      .where("scope_hash", "=", scope.scopeHash)
      .execute();
  }

  async listScopes(kind: "user" | "project"): Promise<ScopeKey[]> {
    const rows = await this.db
      .selectFrom("memories")
      .select("scope_hash")
      .where("scope", "=", kind)
      .distinct()
      .execute();
    return rows.map((r) => ({ scope: kind, scopeHash: r.scope_hash }));
  }
}
