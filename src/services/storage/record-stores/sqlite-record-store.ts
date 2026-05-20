// src/services/storage/record-stores/sqlite-record-store.ts
import { connectionManager } from "../../sqlite/connection-manager.js";
import { ShardManager } from "../../sqlite/shard-manager.js";
import type {
  ListOptions,
  MemoryRow,
  RecordStore,
  ScopeKey,
  TagsRow,
} from "../types.js";

interface Options {
  storagePath: string;
  embeddingDimensions: number;
}

function vectorToBlob(v: Float32Array | null): Uint8Array | null {
  return v ? new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)) : null;
}

function blobToVector(b: Uint8Array | ArrayBuffer | null | undefined): Float32Array {
  if (!b) return new Float32Array();
  if (b instanceof Uint8Array) {
    return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  }
  return new Float32Array(b);
}

function rowToMemory(row: any): MemoryRow {
  return {
    id: row.id,
    content: row.content,
    containerTag: row.container_tag,
    tags: row.tags ? String(row.tags).split(",") : null,
    type: row.type ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    displayName: row.display_name ?? null,
    userName: row.user_name ?? null,
    userEmail: row.user_email ?? null,
    projectPath: row.project_path ?? null,
    projectName: row.project_name ?? null,
    gitRepoUrl: row.git_repo_url ?? null,
    isPinned: row.is_pinned === 1,
    vector: blobToVector(row.vector),
    tagsVector: row.tags_vector ? blobToVector(row.tags_vector) : null,
  };
}

export class SqliteRecordStore implements RecordStore {
  private readonly shardManager: ShardManager;

  constructor(private readonly opts: Options) {
    this.shardManager = new ShardManager();
  }

  async init(): Promise<void> {
    // ShardManager constructor already initialised metadata DB.
  }

  async close(): Promise<void> {
    // Module-scoped connectionManager — close all so test cleanup (rmSync) is safe
    // and the next instance reopens fresh handles.
    connectionManager.closeAll();
  }

  async insert(scope: ScopeKey, row: MemoryRow): Promise<void> {
    const shard = this.shardManager.getWriteShard(scope.scope, scope.scopeHash);
    const db = connectionManager.getConnection(shard.dbPath);
    db.prepare(
      `INSERT INTO memories (id, content, vector, tags_vector, container_tag, tags, type,
        created_at, updated_at, metadata, display_name, user_name, user_email,
        project_path, project_name, git_repo_url, is_pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.content,
      vectorToBlob(row.vector),
      vectorToBlob(row.tagsVector),
      row.containerTag,
      row.tags ? row.tags.join(",") : null,
      row.type,
      row.createdAt,
      row.updatedAt,
      row.metadata ? JSON.stringify(row.metadata) : null,
      row.displayName,
      row.userName,
      row.userEmail,
      row.projectPath,
      row.projectName,
      row.gitRepoUrl,
      row.isPinned ? 1 : 0,
    );
    this.shardManager.incrementVectorCount(shard.id);
  }

  async update(scope: ScopeKey, id: string, patch: Partial<MemoryRow>): Promise<void> {
    const shard = this.findShardForId(scope, id);
    if (!shard) return;
    const db = connectionManager.getConnection(shard.dbPath);
    const sets: string[] = [];
    const vals: any[] = [];
    const map: Record<string, string> = {
      content: "content",
      containerTag: "container_tag",
      type: "type",
      displayName: "display_name",
      userName: "user_name",
      userEmail: "user_email",
      projectPath: "project_path",
      projectName: "project_name",
      gitRepoUrl: "git_repo_url",
      updatedAt: "updated_at",
    };
    for (const [k, col] of Object.entries(map)) {
      if (k in patch) {
        sets.push(`${col} = ?`);
        vals.push((patch as any)[k]);
      }
    }
    if ("tags" in patch) {
      sets.push("tags = ?");
      vals.push(patch.tags ? patch.tags.join(",") : null);
    }
    if ("metadata" in patch) {
      sets.push("metadata = ?");
      vals.push(patch.metadata ? JSON.stringify(patch.metadata) : null);
    }
    if ("isPinned" in patch) {
      sets.push("is_pinned = ?");
      vals.push(patch.isPinned ? 1 : 0);
    }
    if ("vector" in patch && patch.vector) {
      sets.push("vector = ?");
      vals.push(vectorToBlob(patch.vector));
    }
    if ("tagsVector" in patch) {
      sets.push("tags_vector = ?");
      vals.push(vectorToBlob(patch.tagsVector ?? null));
    }
    if (sets.length === 0) return;
    vals.push(id);
    db.prepare(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }

  async delete(scope: ScopeKey, id: string): Promise<void> {
    const shard = this.findShardForId(scope, id);
    if (!shard) return;
    const db = connectionManager.getConnection(shard.dbPath);
    db.prepare("DELETE FROM memories WHERE id = ?").run(id);
    this.shardManager.decrementVectorCount(shard.id);
  }

  async getById(scope: ScopeKey, id: string): Promise<MemoryRow | null> {
    for (const shard of this.shardManager.getAllShards(scope.scope, scope.scopeHash)) {
      const db = connectionManager.getConnection(shard.dbPath);
      const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
      if (row) return rowToMemory(row);
    }
    return null;
  }

  async list(scope: ScopeKey, opts: ListOptions): Promise<MemoryRow[]> {
    const out: MemoryRow[] = [];
    const limit = opts.limit ?? 10000;
    for (const shard of this.shardManager.getAllShards(scope.scope, scope.scopeHash)) {
      const db = connectionManager.getConnection(shard.dbPath);
      let stmt: any;
      let rows: any[];
      if (opts.sessionId) {
        stmt = db.prepare(
          `SELECT * FROM memories WHERE metadata LIKE ? ORDER BY created_at DESC LIMIT ?`,
        );
        rows = stmt.all(`%"sessionID":"${opts.sessionId}"%`, limit);
      } else if (!opts.containerTag) {
        stmt = db.prepare(`SELECT * FROM memories ORDER BY created_at DESC LIMIT ?`);
        rows = stmt.all(limit);
      } else {
        stmt = db.prepare(
          `SELECT * FROM memories WHERE container_tag = ? ORDER BY created_at DESC LIMIT ?`,
        );
        rows = stmt.all(opts.containerTag, limit);
      }
      for (const r of rows) out.push(rowToMemory(r));
      if (out.length >= limit) break;
    }
    return out.slice(0, limit);
  }

  async countByContainer(scope: ScopeKey, containerTag: string): Promise<number> {
    let total = 0;
    for (const shard of this.shardManager.getAllShards(scope.scope, scope.scopeHash)) {
      const db = connectionManager.getConnection(shard.dbPath);
      const r: any = db.prepare("SELECT COUNT(*) AS c FROM memories WHERE container_tag = ?").get(containerTag);
      total += r.c;
    }
    return total;
  }

  async countAll(scope: ScopeKey): Promise<number> {
    let total = 0;
    for (const shard of this.shardManager.getAllShards(scope.scope, scope.scopeHash)) {
      const db = connectionManager.getConnection(shard.dbPath);
      const r: any = db.prepare("SELECT COUNT(*) AS c FROM memories").get();
      total += r.c;
    }
    return total;
  }

  async distinctTags(scope: ScopeKey): Promise<TagsRow[]> {
    const seen = new Set<string>();
    const out: TagsRow[] = [];
    for (const shard of this.shardManager.getAllShards(scope.scope, scope.scopeHash)) {
      const db = connectionManager.getConnection(shard.dbPath);
      const rows: any[] = db.prepare(
        `SELECT DISTINCT container_tag, display_name, user_name, user_email,
          project_path, project_name, git_repo_url FROM memories`,
      ).all();
      for (const r of rows) {
        const k = JSON.stringify(r);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({
          containerTag: r.container_tag,
          displayName: r.display_name ?? null,
          userName: r.user_name ?? null,
          userEmail: r.user_email ?? null,
          projectPath: r.project_path ?? null,
          projectName: r.project_name ?? null,
          gitRepoUrl: r.git_repo_url ?? null,
        });
      }
    }
    return out;
  }

  async getByIds(scope: ScopeKey, ids: string[], containerTag: string): Promise<MemoryRow[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const out: MemoryRow[] = [];
    for (const shard of this.shardManager.getAllShards(scope.scope, scope.scopeHash)) {
      const db = connectionManager.getConnection(shard.dbPath);
      const sql = containerTag === ""
        ? `SELECT * FROM memories WHERE id IN (${placeholders})`
        : `SELECT * FROM memories WHERE id IN (${placeholders}) AND container_tag = ?`;
      const rows: any[] = (containerTag === "")
        ? db.prepare(sql).all(...ids)
        : db.prepare(sql).all(...ids, containerTag);
      for (const r of rows) out.push(rowToMemory(r));
    }
    return out;
  }

  iterateVectors(
    scope: ScopeKey,
    kind: "content" | "tags",
  ): AsyncIterable<{ id: string; vector: Float32Array }> {
    const column = kind === "tags" ? "tags_vector" : "vector";
    const shards = this.shardManager.getAllShards(scope.scope, scope.scopeHash);
    return (async function* () {
      for (const shard of shards) {
        const db = connectionManager.getConnection(shard.dbPath);
        const stmt = db.prepare(
          `SELECT id, ${column} AS blob FROM memories WHERE ${column} IS NOT NULL`,
        );
        for (const row of stmt.iterate() as Iterable<{ id: string; blob: Uint8Array }>) {
          yield { id: row.id, vector: blobToVector(row.blob) };
        }
      }
    })();
  }

  async setPinned(scope: ScopeKey, id: string, pinned: boolean): Promise<void> {
    const shard = this.findShardForId(scope, id);
    if (!shard) return;
    const db = connectionManager.getConnection(shard.dbPath);
    db.prepare("UPDATE memories SET is_pinned = ? WHERE id = ?").run(pinned ? 1 : 0, id);
  }

  async listScopes(scopeKind: "user" | "project"): Promise<ScopeKey[]> {
    const shards = this.shardManager.getAllShards(scopeKind, "");
    const seen = new Set<string>();
    const out: ScopeKey[] = [];
    for (const s of shards) {
      if (seen.has(s.scopeHash)) continue;
      seen.add(s.scopeHash);
      out.push({ scope: scopeKind, scopeHash: s.scopeHash });
    }
    return out;
  }

  // Returns the shard that owns `id`, if any.
  private findShardForId(scope: ScopeKey, id: string) {
    for (const shard of this.shardManager.getAllShards(scope.scope, scope.scopeHash)) {
      const db = connectionManager.getConnection(shard.dbPath);
      const r = db.prepare("SELECT 1 AS x FROM memories WHERE id = ?").get(id);
      if (r) return shard;
    }
    return null;
  }
}
