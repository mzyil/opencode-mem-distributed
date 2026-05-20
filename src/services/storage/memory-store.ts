// src/services/storage/memory-store.ts
import { log } from "../logger.js";
import type { VectorBackend } from "../vector-backends/types.js";
import type {
  ListOptions,
  MemoryRow,
  RecordStore,
  ScopeKey,
  TagsRow,
} from "./types.js";

export interface SearchResult {
  id: string;
  memory: string;
  similarity: number;
  tags: string[];
  metadata?: Record<string, unknown>;
  containerTag: string;
  displayName: string | null;
  userName: string | null;
  userEmail: string | null;
  projectPath: string | null;
  projectName: string | null;
  gitRepoUrl: string | null;
  isPinned: boolean;
}

export class MemoryStore {
  constructor(
    private readonly recordStore: RecordStore,
    private readonly vectorBackend: VectorBackend,
  ) {}

  async init(): Promise<void> {
    await this.recordStore.init();
  }

  async close(): Promise<void> {
    await this.recordStore.close();
  }

  async insert(scope: ScopeKey, row: MemoryRow): Promise<void> {
    await this.recordStore.insert(scope, row);
    try {
      await this.vectorBackend.insert({
        id: row.id, vector: row.vector,
        ns: { scope: scope.scope, scopeHash: scope.scopeHash },
        kind: "content",
      });
      if (row.tagsVector) {
        await this.vectorBackend.insert({
          id: row.id, vector: row.tagsVector,
          ns: { scope: scope.scope, scopeHash: scope.scopeHash },
          kind: "tags",
        });
      }
    } catch (error) {
      await this.recordStore.delete(scope, row.id).catch(() => {});
      throw error;
    }
  }

  async update(scope: ScopeKey, id: string, patch: Partial<MemoryRow>): Promise<void> {
    await this.recordStore.update(scope, id, patch);
    if (patch.vector) {
      await this.vectorBackend.insert({
        id, vector: patch.vector,
        ns: { scope: scope.scope, scopeHash: scope.scopeHash },
        kind: "content",
      });
    }
    if ("tagsVector" in patch) {
      const ns = { scope: scope.scope, scopeHash: scope.scopeHash };
      if (patch.tagsVector) {
        await this.vectorBackend.insert({ id, vector: patch.tagsVector, ns, kind: "tags" });
      } else {
        await this.vectorBackend.delete({ id, ns, kind: "tags" });
      }
    }
  }

  async delete(scope: ScopeKey, id: string): Promise<void> {
    const ns = { scope: scope.scope, scopeHash: scope.scopeHash };
    await this.recordStore.delete(scope, id);
    await this.vectorBackend.delete({ id, ns, kind: "content" });
    await this.vectorBackend.delete({ id, ns, kind: "tags" });
  }

  getById(scope: ScopeKey, id: string): Promise<MemoryRow | null> {
    return this.recordStore.getById(scope, id);
  }

  list(scope: ScopeKey, opts: ListOptions): Promise<MemoryRow[]> {
    return this.recordStore.list(scope, opts);
  }

  countByContainer(scope: ScopeKey, containerTag: string): Promise<number> {
    return this.recordStore.countByContainer(scope, containerTag);
  }

  countAll(scope: ScopeKey): Promise<number> {
    return this.recordStore.countAll(scope);
  }

  distinctTags(scope: ScopeKey): Promise<TagsRow[]> {
    return this.recordStore.distinctTags(scope);
  }

  listScopes(kind: "user" | "project"): Promise<ScopeKey[]> {
    return this.recordStore.listScopes(kind);
  }

  setPinned(scope: ScopeKey, id: string, pinned: boolean): Promise<void> {
    return this.recordStore.setPinned(scope, id, pinned);
  }

  async search(
    scope: ScopeKey,
    queryVector: Float32Array,
    containerTag: string,
    limit: number,
    similarityThreshold: number,
    queryText?: string,
  ): Promise<SearchResult[]> {
    const ns = { scope: scope.scope, scopeHash: scope.scopeHash };

    await this.vectorBackend.rebuildFromSource({
      ns, kind: "content", source: this.recordStore.iterateVectors(scope, "content"),
    });
    await this.vectorBackend.rebuildFromSource({
      ns, kind: "tags", source: this.recordStore.iterateVectors(scope, "tags"),
    });

    const [content, tags] = await Promise.all([
      this.vectorBackend.search({ ns, kind: "content", queryVector, limit: limit * 4 }),
      this.vectorBackend.search({ ns, kind: "tags", queryVector, limit: limit * 4 }),
    ]);

    const scoreMap = new Map<string, { contentSim: number; tagsSim: number }>();
    for (const r of content) scoreMap.set(r.id, { contentSim: 1 - r.distance, tagsSim: 0 });
    for (const r of tags) {
      const e = scoreMap.get(r.id);
      if (e) e.tagsSim = 1 - r.distance;
      else scoreMap.set(r.id, { contentSim: 0, tagsSim: 1 - r.distance });
    }

    const ids = Array.from(scoreMap.keys());
    if (ids.length === 0) return [];

    const rows = await this.recordStore.getByIds(scope, ids, containerTag);
    const queryWords = queryText
      ? queryText.toLowerCase().split(/[\s,]+/).filter((w) => w.length > 1)
      : [];

    const hydrated: SearchResult[] = rows.map((row) => {
      const scores = scoreMap.get(row.id)!;
      const memoryTags = (row.tags ?? []).map((t) => t.toLowerCase());
      let exactBoost = 0;
      if (queryWords.length > 0 && memoryTags.length > 0) {
        const matches = queryWords.filter((w) =>
          memoryTags.some((t) => t.includes(w) || w.includes(t))
        ).length;
        exactBoost = matches / Math.max(queryWords.length, 1);
      }
      const finalTagsSim = Math.max(scores.tagsSim, exactBoost);
      const similarity = scores.contentSim * 0.6 + finalTagsSim * 0.4;
      return {
        id: row.id,
        memory: row.content,
        similarity,
        tags: row.tags ?? [],
        metadata: row.metadata ?? undefined,
        containerTag: row.containerTag,
        displayName: row.displayName,
        userName: row.userName,
        userEmail: row.userEmail,
        projectPath: row.projectPath,
        projectName: row.projectName,
        gitRepoUrl: row.gitRepoUrl,
        isPinned: row.isPinned,
      };
    });

    hydrated.sort((a, b) => b.similarity - a.similarity);
    return hydrated.filter((r) => r.similarity >= similarityThreshold).slice(0, limit);
  }
}
