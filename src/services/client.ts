import { embeddingService } from "./embedding.js";
import { getMemoryStore } from "./storage/index.js";
import type { MemoryRow, ScopeKey } from "./storage/types.js";
import { CONFIG } from "../config.js";
import { log } from "./logger.js";
import type { MemoryType } from "../types/index.js";

export type MemoryScope = string;

function safeToISOString(timestamp: any): string {
  try {
    if (timestamp === null || timestamp === undefined) {
      return new Date().toISOString();
    }
    const numValue = typeof timestamp === "bigint" ? Number(timestamp) : Number(timestamp);

    if (isNaN(numValue) || numValue < 0) {
      return new Date().toISOString();
    }

    return new Date(numValue).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function extractScopeFromContainerTag(containerTag: string): {
  scope: string;
  hash: string;
} {
  const parts = containerTag.split("_");
  if (parts.length >= 3) {
    const scope = parts[1]!;
    const hash = parts.slice(2).join("_");
    return { scope, hash };
  }
  return { scope: "user", hash: containerTag };
}

export class LocalMemoryClient {
  private initPromise: Promise<void> | null = null;
  private isInitialized: boolean = false;

  constructor() {}

  private async initialize(): Promise<void> {
    if (this.isInitialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        // Touch the storage singleton so any init/migration runs eagerly.
        await getMemoryStore();
        this.isInitialized = true;
      } catch (error) {
        this.initPromise = null;
        log("Storage initialization failed", { error: String(error) });
        throw error;
      }
    })();

    return this.initPromise;
  }

  async warmup(progressCallback?: (progress: any) => void): Promise<void> {
    await this.initialize();
    await embeddingService.warmup(progressCallback);
  }

  async isReady(): Promise<boolean> {
    return this.isInitialized && embeddingService.isWarmedUp;
  }

  getStatus(): {
    dbConnected: boolean;
    modelLoaded: boolean;
    ready: boolean;
  } {
    return {
      dbConnected: this.isInitialized,
      modelLoaded: embeddingService.isWarmedUp,
      ready: this.isInitialized && embeddingService.isWarmedUp,
    };
  }

  async close(): Promise<void> {
    // MemoryStore lifecycle is owned by resetMemoryStore() in src/index.ts.
    // Avoid re-instantiating the singleton during shutdown.
  }

  async searchMemories(query: string, containerTag: string, scopes: string[]) {
    try {
      await this.initialize();

      const effectiveScopes: string[] = scopes.length > 0 ? scopes : [CONFIG.memory.defaultScope];
      const queryVector = await embeddingService.embedWithTimeout(query);
      const store = await getMemoryStore();

      // "all-projects" expands to every known project scope string.
      let resolvedScopes: string[];
      if (effectiveScopes.includes("all-projects")) {
        const projectScopeKeys = await store.listScopes("project");
        resolvedScopes = projectScopeKeys.map((sk) => sk.scope);
      } else {
        resolvedScopes = effectiveScopes;
      }

      const targetContainerTag = effectiveScopes.includes("all-projects") ? "" : containerTag;

      const results = await store.search(
        resolvedScopes,
        queryVector,
        targetContainerTag,
        CONFIG.maxMemories,
        CONFIG.similarityThreshold,
        query
      );

      return { success: true as const, results, total: results.length, timing: 0 };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("searchMemories: error", { error: errorMessage });
      return { success: false as const, error: errorMessage, results: [], total: 0, timing: 0 };
    }
  }

  async addMemory(
    content: string,
    containerTag: string,
    metadata?: {
      type?: MemoryType;
      source?: "manual" | "auto-capture" | "import" | "api";
      tags?: string[];
      tool?: string;
      sessionID?: string;
      reasoning?: string;
      captureTimestamp?: number;
      displayName?: string;
      userName?: string;
      userEmail?: string;
      projectPath?: string;
      projectName?: string;
      gitRepoUrl?: string;
      [key: string]: unknown;
    },
    scope?: string
  ) {
    try {
      await this.initialize();

      const tags = metadata?.tags || [];
      const vector = await embeddingService.embedWithTimeout(content);
      let tagsVector: Float32Array | null = null;

      if (tags.length > 0) {
        tagsVector = await embeddingService.embedWithTimeout(tags.join(", "));
      }

      const derived = extractScopeFromContainerTag(containerTag);
      const scopeKey: ScopeKey = scope
        ? { scope, scopeHash: derived.hash }
        : { scope: derived.scope, scopeHash: derived.hash };

      const id = `mem_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
      const now = Date.now();

      const {
        displayName,
        userName,
        userEmail,
        projectPath,
        projectName,
        gitRepoUrl,
        type,
        tags: _tags,
        ...dynamicMetadata
      } = metadata || {};

      const row: MemoryRow = {
        id,
        content,
        vector,
        tagsVector,
        containerTag,
        tags: tags.length > 0 ? tags : null,
        type: type ?? null,
        createdAt: now,
        updatedAt: now,
        displayName: displayName ?? null,
        userName: userName ?? null,
        userEmail: userEmail ?? null,
        projectPath: projectPath ?? null,
        projectName: projectName ?? null,
        gitRepoUrl: gitRepoUrl ?? null,
        isPinned: false,
        metadata: Object.keys(dynamicMetadata).length > 0 ? dynamicMetadata : null,
      };

      const store = await getMemoryStore();
      await store.insert(scopeKey, row);

      return { success: true as const, id };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("addMemory: error", { error: errorMessage });
      return { success: false as const, error: errorMessage };
    }
  }

  async deleteMemory(memoryId: string) {
    try {
      await this.initialize();

      const store = await getMemoryStore();
      const userScopes = await store.listScopes("user");
      const projectScopes = await store.listScopes("project");

      for (const sk of [...userScopes, ...projectScopes]) {
        const memory = await store.getById(sk, memoryId);
        if (memory) {
          await store.delete(sk, memoryId);
          return { success: true };
        }
      }

      return { success: false, error: "Memory not found" };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("deleteMemory: error", { memoryId, error: errorMessage });
      return { success: false, error: errorMessage };
    }
  }

  async listMemories(containerTag: string, limit = 20, scopes: string[] = ["project"]) {
    try {
      await this.initialize();

      const effectiveScopes: string[] = scopes.length > 0 ? scopes : [CONFIG.memory.defaultScope];
      const store = await getMemoryStore();

      // "all-projects" expands to every known project scope string.
      let resolvedScopes: string[];
      if (effectiveScopes.includes("all-projects")) {
        const projectScopeKeys = await store.listScopes("project");
        resolvedScopes = projectScopeKeys.map((sk) => sk.scope);
      } else {
        resolvedScopes = effectiveScopes;
      }

      const targetContainerTag = effectiveScopes.includes("all-projects") ? "" : containerTag;

      const allMemories: MemoryRow[] = await store.list(resolvedScopes, {
        containerTag: targetContainerTag,
        limit,
      });

      allMemories.sort((a, b) => Number(b.createdAt) - Number(a.createdAt));

      const memories = allMemories.slice(0, limit).map((r) => ({
        id: r.id,
        summary: r.content,
        createdAt: safeToISOString(r.createdAt),
        metadata: r.metadata ?? undefined,
        displayName: r.displayName ?? undefined,
        userName: r.userName ?? undefined,
        userEmail: r.userEmail ?? undefined,
        projectPath: r.projectPath ?? undefined,
        projectName: r.projectName ?? undefined,
        gitRepoUrl: r.gitRepoUrl ?? undefined,
      }));

      return {
        success: true as const,
        memories,
        pagination: { currentPage: 1, totalItems: memories.length, totalPages: 1 },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("listMemories: error", { error: errorMessage });
      return {
        success: false as const,
        error: errorMessage,
        memories: [],
        pagination: { currentPage: 1, totalItems: 0, totalPages: 0 },
      };
    }
  }

  async searchMemoriesBySessionID(sessionID: string, containerTag: string, limit: number = 10) {
    try {
      await this.initialize();

      const { scope } = extractScopeFromContainerTag(containerTag);
      const store = await getMemoryStore();

      const rows = await store.list([scope], { sessionId: sessionID, limit });

      rows.sort((a, b) => b.createdAt - a.createdAt);

      const results = rows.slice(0, limit).map((row) => ({
        id: row.id,
        memory: row.content,
        similarity: 1.0,
        tags: row.tags ?? [],
        metadata: row.metadata ?? {},
        containerTag: row.containerTag,
        displayName: row.displayName,
        userName: row.userName,
        userEmail: row.userEmail,
        projectPath: row.projectPath,
        projectName: row.projectName,
        gitRepoUrl: row.gitRepoUrl,
        createdAt: row.createdAt,
      }));

      return { success: true as const, results, total: results.length, timing: 0 };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("searchMemoriesBySessionID: error", { error: errorMessage });
      return { success: false as const, error: errorMessage, results: [], total: 0, timing: 0 };
    }
  }
}

export const memoryClient = new LocalMemoryClient();
