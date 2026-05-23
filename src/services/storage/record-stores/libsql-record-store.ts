// src/services/storage/record-stores/libsql-record-store.ts
import { createClient, type Client } from "@libsql/client";
import { Kysely } from "kysely";
import { LibsqlDialect } from "kysely-libsql";
import { runMigrations } from "../migrations/bootstrap.js";
import type { ListOptions, MemoryRow, RecordStore, ScopeKey, TagsRow } from "../types.js";
import {
  bufferToVector,
  joinTags,
  rowFromDb,
  serializeMetadata,
  sessionIdFromMetadata,
  vectorToBuffer,
} from "./codecs.js";

interface Options {
  url: string;
  authToken?: string;
}

type Db = Kysely<any>;

export class LibsqlRecordStore implements RecordStore {
  private client!: Client;
  private db!: Db;

  constructor(private readonly opts: Options) {}

  async init(): Promise<void> {
    this.client = createClient({ url: this.opts.url, authToken: this.opts.authToken });
    this.db = new Kysely({ dialect: new LibsqlDialect({ client: this.client }) });
    await runMigrations(this.db, "libsql");
  }

  async close(): Promise<void> {
    await this.db.destroy();
    this.client.close();
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
        metadata: serializeMetadata(row.metadata),
        session_id: sessionIdFromMetadata(row.metadata),
        display_name: row.displayName,
        user_name: row.userName,
        user_email: row.userEmail,
        project_path: row.projectPath,
        project_name: row.projectName,
        git_repo_url: row.gitRepoUrl,
        is_pinned: row.isPinned ? 1 : 0,
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
    if (patch.metadata !== undefined) {
      set.metadata = serializeMetadata(patch.metadata);
      set.session_id = sessionIdFromMetadata(patch.metadata);
    }
    if (patch.displayName !== undefined) set.display_name = patch.displayName;
    if (patch.userName !== undefined) set.user_name = patch.userName;
    if (patch.userEmail !== undefined) set.user_email = patch.userEmail;
    if (patch.projectPath !== undefined) set.project_path = patch.projectPath;
    if (patch.projectName !== undefined) set.project_name = patch.projectName;
    if (patch.gitRepoUrl !== undefined) set.git_repo_url = patch.gitRepoUrl;
    if (patch.updatedAt !== undefined) set.updated_at = patch.updatedAt;
    if (patch.isPinned !== undefined) set.is_pinned = patch.isPinned ? 1 : 0;
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

  async list(scopes: string[], opts: ListOptions): Promise<MemoryRow[]> {
    if (!scopes || scopes.length === 0) return [];
    let q = this.db.selectFrom("memories").selectAll().where("scope", "in", scopes);
    if (opts.sessionId) {
      q = q.where("session_id", "=", opts.sessionId);
    } else if (opts.containerTag) {
      q = q.where("container_tag", "=", opts.containerTag);
    }
    q = q.orderBy("created_at", "desc");
    if (opts.limit !== undefined) q = q.limit(opts.limit);
    const rows = await q.execute();
    return rows.map((r) => rowFromDb(r, "vector_bytes", "tags_vector_bytes"));
  }

  async countByContainer(scopes: string[], containerTag: string): Promise<number> {
    if (!scopes || scopes.length === 0) return 0;
    const r = await this.db
      .selectFrom("memories")
      .select(({ fn }) => [fn.countAll<number>().as("c")])
      .where("scope", "in", scopes)
      .where("container_tag", "=", containerTag)
      .executeTakeFirst();
    return Number(r?.c ?? 0);
  }

  async countAll(scopes: string[]): Promise<number> {
    if (!scopes || scopes.length === 0) return 0;
    const r = await this.db
      .selectFrom("memories")
      .select(({ fn }) => [fn.countAll<number>().as("c")])
      .where("scope", "in", scopes)
      .executeTakeFirst();
    return Number(r?.c ?? 0);
  }

  async distinctTags(scopes: string[]): Promise<TagsRow[]> {
    if (!scopes || scopes.length === 0) return [];
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
      .where("scope", "in", scopes)
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

  async getByIds(scopes: string[], ids: string[], containerTag: string): Promise<MemoryRow[]> {
    if (ids.length === 0 || !scopes || scopes.length === 0) return [];
    let q = this.db
      .selectFrom("memories")
      .selectAll()
      .where("scope", "in", scopes)
      .where("id", "in", ids);
    if (containerTag !== "") q = q.where("container_tag", "=", containerTag);
    const rows = await q.execute();
    return rows.map((r) => rowFromDb(r, "vector_bytes", "tags_vector_bytes"));
  }

  async lookupScopeKeys(scopes: string[]): Promise<ScopeKey[]> {
    if (!scopes || scopes.length === 0) return [];
    const rows = await this.db
      .selectFrom("memories")
      .select(["scope", "scope_hash"])
      .where("scope", "in", scopes)
      .distinct()
      .execute();
    return rows.map((r) => ({ scope: r.scope as string, scopeHash: r.scope_hash as string }));
  }

  iterateVectors(
    scope: ScopeKey,
    kind: "content" | "tags"
  ): AsyncIterable<{ id: string; vector: Float32Array }> {
    const col = kind === "tags" ? "tags_vector_bytes" : "vector_bytes";
    const db = this.db;
    const s = scope;
    // TODO(perf): stream via libsql when streaming API is stable; buffered execute() for now
    return (async function* () {
      const rows = await db
        .selectFrom("memories")
        .select(["id", col as any])
        .where("scope", "=", s.scope)
        .where("scope_hash", "=", s.scopeHash)
        .where(col as any, "is not", null)
        .execute();
      for (const row of rows as Array<{ id: string } & Record<string, unknown>>) {
        const buf = row[col] as Buffer | Uint8Array | ArrayBuffer | null | undefined;
        if (!buf) continue;
        yield { id: row.id, vector: bufferToVector(buf) };
      }
    })();
  }

  async setPinned(scope: ScopeKey, id: string, pinned: boolean): Promise<void> {
    await this.db
      .updateTable("memories")
      .set({ is_pinned: pinned ? 1 : 0 })
      .where("id", "=", id)
      .where("scope", "=", scope.scope)
      .where("scope_hash", "=", scope.scopeHash)
      .execute();
  }

  // Legacy scope enumeration kept for back-compat with old data shapes.
  // New callers should use list-by-prefix or scope-array reads instead.
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
