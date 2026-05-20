import { embeddingService } from "./embedding.js";
import { getMemoryStore } from "./storage/index.js";
import type { MemoryRow, ScopeKey } from "./storage/types.js";
import { log } from "./logger.js";
import { CONFIG } from "../config.js";
import type { MemoryType } from "../types/index.js";
import { userPromptManager } from "./user-prompt/user-prompt-manager.js";

interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

interface Memory {
  id: string;
  content: string;
  type?: string;
  tags?: string[];
  createdAt: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
  displayName?: string;
  userName?: string;
  userEmail?: string;
  projectPath?: string;
  projectName?: string;
  gitRepoUrl?: string;
  isPinned?: boolean;
}

interface TagInfo {
  tag: string;
  tags?: string[];
  displayName?: string;
  userName?: string;
  userEmail?: string;
  projectPath?: string;
  projectName?: string;
  gitRepoUrl?: string;
}

interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

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

function extractScopeFromTag(tag: string): { scope: "project"; hash: string } {
  const parts = tag.split("_");
  if (parts.length >= 3) {
    const hash = parts.slice(2).join("_");
    return { scope: "project", hash };
  }
  return { scope: "project", hash: tag };
}

async function getProjectPathFromTag(tag: string): Promise<string | undefined> {
  const store = await getMemoryStore();
  const projectScopes = await store.listScopes("project");
  for (const sk of projectScopes) {
    const tags = await store.distinctTags(sk);
    for (const t of tags) {
      if (t.containerTag === tag && t.projectPath) {
        return t.projectPath;
      }
    }
  }
  return undefined;
}

// Walk every project scope looking for a memory by id. Returns the
// (scopeKey, row) tuple if found, else null.
async function findMemoryAcrossProjects(
  id: string,
): Promise<{ scope: ScopeKey; row: MemoryRow } | null> {
  const store = await getMemoryStore();
  const projectScopes = await store.listScopes("project");
  for (const sk of projectScopes) {
    const row = await store.getById(sk, id);
    if (row) return { scope: sk, row };
  }
  return null;
}

export async function handleListTags(): Promise<ApiResponse<{ project: TagInfo[] }>> {
  try {
    // Tags are stored as SQLite metadata; embedding model is not needed.
    // Calling warmup() here would block on local transformer init in the worker
    // thread and hang every read API. Only handlers that compute similarity
    // (e.g. handleSearch) should warm up the embedding service.
    const store = await getMemoryStore();
    const projectScopes = await store.listScopes("project");
    const tagsMap = new Map<string, TagInfo>();
    for (const sk of projectScopes) {
      const tags = await store.distinctTags(sk);
      for (const t of tags) {
        if (t.containerTag && !tagsMap.has(t.containerTag)) {
          tagsMap.set(t.containerTag, {
            tag: t.containerTag,
            displayName: t.displayName ?? undefined,
            userName: t.userName ?? undefined,
            userEmail: t.userEmail ?? undefined,
            projectPath: t.projectPath ?? undefined,
            projectName: t.projectName ?? undefined,
            gitRepoUrl: t.gitRepoUrl ?? undefined,
          });
        }
      }
    }
    const projectTags: TagInfo[] = [];
    for (const tagInfo of tagsMap.values()) {
      if (tagInfo.tag.includes("_project_")) {
        projectTags.push(tagInfo);
      }
    }
    return { success: true, data: { project: projectTags } };
  } catch (error) {
    log("handleListTags: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleListMemories(
  tag?: string,
  page: number = 1,
  pageSize: number = 20,
  includePrompts: boolean = true
): Promise<ApiResponse<PaginatedResponse<Memory | any>>> {
  try {
    // Listing only reads SQLite rows; no vector ops happen here.
    // See handleListTags comment - keep embedding init out of read paths.
    const store = await getMemoryStore();
    let allMemories: MemoryRow[] = [];
    if (tag) {
      const { scope, hash } = extractScopeFromTag(tag);
      const scopeKey: ScopeKey = { scope, scopeHash: hash };
      allMemories = await store.list(scopeKey, { containerTag: tag, limit: 10000 });
    } else {
      const projectScopes = await store.listScopes("project");
      for (const sk of projectScopes) {
        const rows = await store.list(sk, {});
        allMemories.push(...rows.filter((m) => m.containerTag?.includes(`_project_`)));
      }
    }

    const memoriesWithType = allMemories.map((r) => {
      const metadata = r.metadata ?? undefined;
      return {
        type: "memory",
        id: r.id,
        content: r.content,
        memoryType: r.type,
        tags: r.tags ?? [],
        createdAt: Number(r.createdAt),
        updatedAt: r.updatedAt ? Number(r.updatedAt) : undefined,
        metadata,
        linkedPromptId: (metadata as any)?.promptId,
        displayName: r.displayName,
        userName: r.userName,
        userEmail: r.userEmail,
        projectPath: r.projectPath,
        projectName: r.projectName,
        gitRepoUrl: r.gitRepoUrl,
        isPinned: r.isPinned,
      };
    });

    let timeline: any[] = memoriesWithType;
    if (includePrompts) {
      const projectPath = tag ? await getProjectPathFromTag(tag) : undefined;
      const prompts = userPromptManager.getCapturedPrompts(projectPath);
      const promptsWithType = prompts.map((p) => ({
        type: "prompt",
        id: p.id,
        sessionId: p.sessionId,
        content: p.content,
        createdAt: p.createdAt,
        projectPath: p.projectPath,
        linkedMemoryId: p.linkedMemoryId,
      }));
      timeline = [...memoriesWithType, ...promptsWithType];
    }

    const linkedPairs = new Map<string, { memory: any; prompt: any }>();
    const standalone: any[] = [];
    for (const item of timeline) {
      if (item.type === "memory" && item.linkedPromptId) {
        if (!linkedPairs.has(item.linkedPromptId)) {
          linkedPairs.set(item.linkedPromptId, { memory: item, prompt: null });
        } else {
          linkedPairs.get(item.linkedPromptId)!.memory = item;
        }
      } else if (item.type === "prompt" && item.linkedMemoryId) {
        if (!linkedPairs.has(item.id)) {
          linkedPairs.set(item.id, { memory: null, prompt: item });
        } else {
          linkedPairs.get(item.id)!.prompt = item;
        }
      } else {
        standalone.push(item);
      }
    }

    const sortedTimeline: any[] = [];
    const pairs = Array.from(linkedPairs.values())
      .filter((p) => p.memory && p.prompt)
      .sort((a, b) => b.memory.createdAt - a.memory.createdAt);
    for (const pair of pairs) {
      sortedTimeline.push(pair.memory);
      sortedTimeline.push(pair.prompt);
    }
    standalone.sort((a, b) => b.createdAt - a.createdAt);
    sortedTimeline.push(...standalone);
    timeline = sortedTimeline;

    const total = timeline.length;
    const totalPages = Math.ceil(total / pageSize);
    const offset = (page - 1) * pageSize;
    const paginatedResults = timeline.slice(offset, offset + pageSize);

    const items = paginatedResults.map((item: any) => {
      if (item.type === "memory") {
        return {
          type: "memory",
          id: item.id,
          content: item.content,
          memoryType: item.memoryType,
          tags: item.tags,
          createdAt: safeToISOString(item.createdAt),
          updatedAt: item.updatedAt ? safeToISOString(item.updatedAt) : undefined,
          metadata: item.metadata,
          linkedPromptId: item.linkedPromptId,
          displayName: item.displayName,
          userName: item.userName,
          userEmail: item.userEmail,
          projectPath: item.projectPath,
          projectName: item.projectName,
          gitRepoUrl: item.gitRepoUrl,
          isPinned: item.isPinned,
        };
      } else {
        return {
          type: "prompt",
          id: item.id,
          sessionId: item.sessionId,
          content: item.content,
          createdAt: safeToISOString(item.createdAt),
          projectPath: item.projectPath,
          linkedMemoryId: item.linkedMemoryId,
        };
      }
    });

    return { success: true, data: { items, total, page, pageSize, totalPages } };
  } catch (error) {
    log("handleListMemories: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleAddMemory(data: {
  content: string;
  containerTag: string;
  type?: MemoryType;
  tags?: string[];
  displayName?: string;
  userName?: string;
  userEmail?: string;
  projectPath?: string;
  projectName?: string;
  gitRepoUrl?: string;
}): Promise<ApiResponse<{ id: string }>> {
  try {
    if (!data.content || !data.containerTag) {
      return { success: false, error: "content and containerTag are required" };
    }
    await embeddingService.warmup();
    const tags = (data.tags || []).map((t) => t.trim().toLowerCase());
    const embeddingInput =
      tags.length > 0 ? `${data.content}\nTags: ${tags.join(", ")}` : data.content;

    const vector = await embeddingService.embedWithTimeout(embeddingInput);
    let tagsVector: Float32Array | null = null;
    if (tags.length > 0) {
      tagsVector = await embeddingService.embedWithTimeout(tags.join(", "));
    }

    const { scope, hash } = extractScopeFromTag(data.containerTag);
    const scopeKey: ScopeKey = { scope, scopeHash: hash };

    const id = `mem_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    const now = Date.now();

    const row: MemoryRow = {
      id,
      content: data.content,
      vector,
      tagsVector,
      containerTag: data.containerTag,
      tags: tags.length > 0 ? tags : null,
      type: data.type ?? null,
      createdAt: now,
      updatedAt: now,
      displayName: data.displayName ?? null,
      userName: data.userName ?? null,
      userEmail: data.userEmail ?? null,
      projectPath: data.projectPath ?? null,
      projectName: data.projectName ?? null,
      gitRepoUrl: data.gitRepoUrl ?? null,
      isPinned: false,
      metadata: { source: "api" },
    };

    const store = await getMemoryStore();
    await store.insert(scopeKey, row);
    return { success: true, data: { id } };
  } catch (error) {
    log("handleAddMemory: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleDeleteMemory(
  id: string,
  cascade: boolean = false
): Promise<ApiResponse<{ deletedPrompt: boolean }>> {
  try {
    if (!id) return { success: false, error: "id is required" };
    const store = await getMemoryStore();
    const found = await findMemoryAcrossProjects(id);
    if (!found) return { success: false, error: "Memory not found" };

    const linkedPromptId = (found.row.metadata as any)?.promptId;
    if (cascade && linkedPromptId) {
      userPromptManager.deletePrompt(linkedPromptId);
    }
    await store.delete(found.scope, id);
    return {
      success: true,
      data: { deletedPrompt: cascade && !!linkedPromptId },
    };
  } catch (error) {
    log("handleDeleteMemory: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleBulkDelete(
  ids: string[],
  cascade: boolean = false
): Promise<ApiResponse<{ deleted: number }>> {
  try {
    if (!ids || ids.length === 0) return { success: false, error: "ids array is required" };
    let deleted = 0;
    for (const id of ids) {
      const result = await handleDeleteMemory(id, cascade);
      if (result.success) deleted++;
    }
    return { success: true, data: { deleted } };
  } catch (error) {
    log("handleBulkDelete: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleUpdateMemory(
  id: string,
  data: { content?: string; type?: MemoryType; tags?: string[] }
): Promise<ApiResponse<void>> {
  try {
    if (!id) return { success: false, error: "id is required" };
    await embeddingService.warmup();

    const store = await getMemoryStore();
    const found = await findMemoryAcrossProjects(id);
    if (!found) return { success: false, error: "Memory not found" };

    const { scope, row: existing } = found;

    const newContent = data.content ?? existing.content;
    const tags = data.tags ?? (existing.tags ?? []);

    const vector = await embeddingService.embedWithTimeout(newContent);
    let tagsVector: Float32Array | null = null;
    if (tags.length > 0) {
      tagsVector = await embeddingService.embedWithTimeout(tags.join(", "));
    }

    await store.update(scope, id, {
      content: newContent,
      type: data.type ?? existing.type ?? null,
      tags: tags.length > 0 ? tags : null,
      updatedAt: Date.now(),
      vector,
      tagsVector,
    });
    return { success: true };
  } catch (error) {
    log("handleUpdateMemory: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

interface FormattedPrompt {
  type: "prompt";
  id: string;
  sessionId: string;
  content: string;
  createdAt: string;
  projectPath: string | null;
  linkedMemoryId: string | null;
  similarity?: number;
  isContext?: boolean;
}

interface FormattedMemory {
  type: "memory";
  id: string;
  content: string;
  memoryType?: string;
  tags?: string[];
  createdAt: string;
  updatedAt?: string;
  similarity?: number;
  metadata?: Record<string, unknown>;
  displayName?: string;
  userName?: string;
  userEmail?: string;
  projectPath?: string;
  projectName?: string;
  gitRepoUrl?: string;
  isPinned?: boolean;
  linkedPromptId?: string;
  isContext?: boolean;
}

type SearchResultItem = FormattedPrompt | FormattedMemory;

export async function handleSearch(
  query: string,
  tag?: string,
  page: number = 1,
  pageSize: number = 20
): Promise<ApiResponse<PaginatedResponse<SearchResultItem>>> {
  try {
    if (!query) return { success: false, error: "query is required" };
    await embeddingService.warmup();
    const queryVector = await embeddingService.embedWithTimeout(query);
    const store = await getMemoryStore();
    let memoryResults: Awaited<ReturnType<typeof store.search>> = [];
    let promptResults: any[] = [];
    if (tag) {
      const { scope, hash } = extractScopeFromTag(tag);
      const scopeKey: ScopeKey = { scope, scopeHash: hash };
      try {
        memoryResults = await store.search(
          scopeKey,
          queryVector,
          tag,
          pageSize * 2,
          0,
          query,
        );
      } catch (error) {
        log("Scope search error", { scope: scopeKey, error: String(error) });
      }
      const projectPath = await getProjectPathFromTag(tag);
      promptResults = userPromptManager.searchPrompts(query, projectPath, pageSize * 2);
    } else {
      const projectScopes = await store.listScopes("project");
      const uniqueTags = new Set<string>();
      for (const sk of projectScopes) {
        const tags = await store.distinctTags(sk);
        for (const t of tags) {
          if (t.containerTag) uniqueTags.add(t.containerTag);
        }
      }
      for (const containerTag of uniqueTags) {
        const { scope, hash } = extractScopeFromTag(containerTag);
        const scopeKey: ScopeKey = { scope, scopeHash: hash };
        try {
          const results = await store.search(
            scopeKey,
            queryVector,
            containerTag,
            pageSize,
            0,
            query,
          );
          memoryResults.push(...results);
        } catch (error) {
          log("Scope search error", { scope: scopeKey, error: String(error) });
        }
      }
      promptResults = userPromptManager.searchPrompts(query, undefined, pageSize * 2);
    }

    const formattedPrompts: FormattedPrompt[] = promptResults.map((p) => ({
      type: "prompt",
      id: p.id,
      sessionId: p.sessionId,
      content: p.content,
      createdAt: safeToISOString(p.createdAt),
      projectPath: p.projectPath,
      linkedMemoryId: p.linkedMemoryId,
      similarity: 1.0,
    }));

    const formattedMemories: FormattedMemory[] = memoryResults.map((r) => ({
      type: "memory",
      id: r.id,
      content: r.memory,
      memoryType: r.type ?? undefined,
      tags: r.tags,
      createdAt: safeToISOString(r.createdAt),
      updatedAt: r.updatedAt ? safeToISOString(r.updatedAt) : undefined,
      similarity: r.similarity,
      metadata: r.metadata,
      displayName: r.displayName ?? undefined,
      userName: r.userName ?? undefined,
      userEmail: r.userEmail ?? undefined,
      projectPath: r.projectPath ?? undefined,
      projectName: r.projectName ?? undefined,
      gitRepoUrl: r.gitRepoUrl ?? undefined,
      isPinned: r.isPinned,
      linkedPromptId: (r.metadata as any)?.promptId,
    }));

    const combinedResults = [...formattedMemories, ...formattedPrompts].sort(
      (a: any, b: any) =>
        (b.similarity || 0) - (a.similarity || 0) || b.createdAt.localeCompare(a.createdAt)
    );

    const total = combinedResults.length;
    const totalPages = Math.ceil(total / pageSize);
    const offset = (page - 1) * pageSize;
    const paginatedResults: SearchResultItem[] = combinedResults.slice(offset, offset + pageSize);

    const missingPromptIds = new Set<string>();
    const missingMemoryIds = new Set<string>();
    for (const item of paginatedResults) {
      if (item.type === "memory" && item.linkedPromptId) {
        if (!paginatedResults.some((p) => p.id === item.linkedPromptId))
          missingPromptIds.add(item.linkedPromptId);
      } else if (item.type === "prompt" && item.linkedMemoryId) {
        if (!paginatedResults.some((m) => m.id === item.linkedMemoryId))
          missingMemoryIds.add(item.linkedMemoryId);
      }
    }

    if (missingPromptIds.size > 0) {
      const extraPrompts = userPromptManager.getPromptsByIds(Array.from(missingPromptIds));
      for (const p of extraPrompts) {
        paginatedResults.push({
          type: "prompt",
          id: p.id,
          sessionId: p.sessionId,
          content: p.content,
          createdAt: safeToISOString(p.createdAt),
          projectPath: p.projectPath,
          linkedMemoryId: p.linkedMemoryId,
          similarity: 0,
          isContext: true,
        });
      }
    }

    if (missingMemoryIds.size > 0) {
      for (const mid of missingMemoryIds) {
        const found = await findMemoryAcrossProjects(mid);
        if (found && !paginatedResults.some((existing) => existing.id === found.row.id)) {
          const m = found.row;
          paginatedResults.push({
            type: "memory",
            id: m.id,
            content: m.content,
            memoryType: m.type ?? undefined,
            tags: m.tags ?? [],
            createdAt: safeToISOString(m.createdAt),
            updatedAt: m.updatedAt ? safeToISOString(m.updatedAt) : undefined,
            similarity: 0,
            metadata: m.metadata ?? undefined,
            displayName: m.displayName ?? undefined,
            userName: m.userName ?? undefined,
            userEmail: m.userEmail ?? undefined,
            projectPath: m.projectPath ?? undefined,
            projectName: m.projectName ?? undefined,
            gitRepoUrl: m.gitRepoUrl ?? undefined,
            isPinned: m.isPinned,
            linkedPromptId: (m.metadata as any)?.promptId,
            isContext: true,
          });
        }
      }
    }

    return { success: true, data: { items: paginatedResults, total, page, pageSize, totalPages } };
  } catch (error) {
    log("handleSearch: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleStats(): Promise<
  ApiResponse<{
    total: number;
    byScope: { user: number; project: number };
    byType: Record<string, number>;
  }>
> {
  try {
    // Stats only counts SQLite rows; no embedding needed.
    // See handleListTags comment - keep embedding init out of read paths.
    const store = await getMemoryStore();
    const projectScopes = await store.listScopes("project");
    let userCount = 0,
      projectCount = 0;
    const typeCount: Record<string, number> = {};
    for (const sk of projectScopes) {
      const rows = await store.list(sk, {});
      for (const r of rows) {
        if (r.containerTag?.includes("_user_")) userCount++;
        else if (r.containerTag?.includes("_project_")) projectCount++;
        if (r.type) typeCount[r.type] = (typeCount[r.type] || 0) + 1;
      }
    }
    return {
      success: true,
      data: {
        total: userCount + projectCount,
        byScope: { user: userCount, project: projectCount },
        byType: typeCount,
      },
    };
  } catch (error) {
    log("handleStats: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handlePinMemory(id: string): Promise<ApiResponse<void>> {
  try {
    if (!id) return { success: false, error: "id is required" };
    const store = await getMemoryStore();
    const found = await findMemoryAcrossProjects(id);
    if (!found) return { success: false, error: "Memory not found" };
    await store.setPinned(found.scope, id, true);
    return { success: true };
  } catch (error) {
    log("handlePinMemory: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleUnpinMemory(id: string): Promise<ApiResponse<void>> {
  try {
    if (!id) return { success: false, error: "id is required" };
    const store = await getMemoryStore();
    const found = await findMemoryAcrossProjects(id);
    if (!found) return { success: false, error: "Memory not found" };
    await store.setPinned(found.scope, id, false);
    return { success: true };
  } catch (error) {
    log("handleUnpinMemory: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleRunCleanup(): Promise<
  ApiResponse<{ deletedCount: number; userCount: number; projectCount: number }>
> {
  try {
    const { cleanupService } = await import("./cleanup-service.js");
    const result = await cleanupService.runCleanup();
    return { success: true, data: result };
  } catch (error) {
    log("handleRunCleanup: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleRunDeduplication(): Promise<
  ApiResponse<{ exactDuplicatesDeleted: number; nearDuplicateGroups: any[] }>
> {
  try {
    const { deduplicationService } = await import("./deduplication-service.js");
    const result = await deduplicationService.detectAndRemoveDuplicates();
    return { success: true, data: result };
  } catch (error) {
    log("handleRunDeduplication: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleDetectMigration(): Promise<
  ApiResponse<{
    needsMigration: boolean;
    configDimensions: number;
    configModel: string;
    shardMismatches: any[];
  }>
> {
  try {
    const { migrationService } = await import("./migration-service.js");
    const result = await migrationService.detectDimensionMismatch();
    return { success: true, data: result };
  } catch (error) {
    log("handleDetectMigration: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleRunMigration(strategy: "fresh-start" | "re-embed"): Promise<
  ApiResponse<{
    success: boolean;
    strategy: string;
    deletedShards: number;
    reEmbeddedMemories: number;
    duration: number;
    error?: string;
  }>
> {
  try {
    const { migrationService } = await import("./migration-service.js");
    const result = await migrationService.migrateToNewModel(strategy);
    return { success: result.success, data: result };
  } catch (error) {
    log("handleRunMigration: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleDeletePrompt(
  id: string,
  cascade: boolean = false
): Promise<ApiResponse<{ deletedMemory: boolean }>> {
  try {
    if (!id) return { success: false, error: "id is required" };
    const prompt = userPromptManager.getPromptById(id);
    if (!prompt) return { success: false, error: "Prompt not found" };
    let deletedMemory = false;
    if (cascade && prompt.linkedMemoryId) {
      const result = await handleDeleteMemory(prompt.linkedMemoryId, false);
      if (result.success) deletedMemory = true;
    }
    userPromptManager.deletePrompt(id);
    return { success: true, data: { deletedMemory } };
  } catch (error) {
    log("handleDeletePrompt: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleBulkDeletePrompts(
  ids: string[],
  cascade: boolean = false
): Promise<ApiResponse<{ deleted: number }>> {
  try {
    if (!ids || ids.length === 0) return { success: false, error: "ids array is required" };
    let deleted = 0;
    for (const id of ids) {
      const result = await handleDeletePrompt(id, cascade);
      if (result.success) deleted++;
    }
    return { success: true, data: { deleted } };
  } catch (error) {
    log("handleBulkDeletePrompts: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleGetUserProfile(userId?: string): Promise<ApiResponse<any>> {
  try {
    const { userProfileManager } = await import("./user-profile/user-profile-manager.js");
    const { getTags } = await import("./tags.js");
    let targetUserId = userId;
    if (!targetUserId) {
      const tags = getTags(process.cwd());
      targetUserId = tags.user.userEmail || "unknown";
    }
    const profile = userProfileManager.getActiveProfile(targetUserId);
    if (!profile)
      return {
        success: true,
        data: {
          exists: false,
          userId: targetUserId,
          message: "No profile found. Keep chatting to build your profile.",
        },
      };
    const profileData = JSON.parse(profile.profileData);
    return {
      success: true,
      data: {
        exists: true,
        id: profile.id,
        userId: profile.userId,
        displayName: profile.displayName,
        userName: profile.userName,
        userEmail: profile.userEmail,
        version: profile.version,
        createdAt: safeToISOString(profile.createdAt),
        lastAnalyzedAt: safeToISOString(profile.lastAnalyzedAt),
        totalPromptsAnalyzed: profile.totalPromptsAnalyzed,
        profileData,
      },
    };
  } catch (error) {
    log("handleGetUserProfile: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleGetProfileChangelog(
  profileId: string,
  limit: number = 5
): Promise<ApiResponse<any[]>> {
  try {
    if (!profileId) return { success: false, error: "profileId is required" };
    const { userProfileManager } = await import("./user-profile/user-profile-manager.js");
    const changelogs = userProfileManager.getProfileChangelogs(profileId, limit);
    const formattedChangelogs = changelogs.map((c) => ({
      id: c.id,
      profileId: c.profileId,
      version: c.version,
      changeType: c.changeType,
      changeSummary: c.changeSummary,
      createdAt: safeToISOString(c.createdAt),
    }));
    return { success: true, data: formattedChangelogs };
  } catch (error) {
    log("handleGetProfileChangelog: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleGetProfileSnapshot(changelogId: string): Promise<ApiResponse<any>> {
  try {
    if (!changelogId) return { success: false, error: "changelogId is required" };
    const { userProfileManager } = await import("./user-profile/user-profile-manager.js");
    const changelogs = userProfileManager.getProfileChangelogs("", 1000);
    const changelog = changelogs.find((c) => c.id === changelogId);
    if (!changelog) return { success: false, error: "Changelog not found" };
    const profileData = JSON.parse(changelog.profileDataSnapshot);
    return {
      success: true,
      data: {
        version: changelog.version,
        createdAt: safeToISOString(changelog.createdAt),
        profileData,
      },
    };
  } catch (error) {
    log("handleGetProfileSnapshot: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleRefreshProfile(userId?: string): Promise<ApiResponse<any>> {
  try {
    const { getTags } = await import("./tags.js");
    const { userPromptManager } = await import("./user-prompt/user-prompt-manager.js");
    let targetUserId = userId;
    if (!targetUserId) {
      const tags = getTags(process.cwd());
      targetUserId = tags.user.userEmail || "unknown";
    }
    const unanalyzedCount = userPromptManager.countUnanalyzedForUserLearning();
    return {
      success: true,
      data: {
        message: "Profile refresh queued",
        unanalyzedPrompts: unanalyzedCount,
        note: "Profile will be updated when threshold is reached",
      },
    };
  } catch (error) {
    log("handleRefreshProfile: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleDetectTagMigration(): Promise<
  ApiResponse<{ needsMigration: boolean; count: number }>
> {
  try {
    const store = await getMemoryStore();
    const projectScopes = await store.listScopes("project");
    let untaggedCount = 0;
    for (const sk of projectScopes) {
      const rows = await store.list(sk, {});
      for (const r of rows) {
        if (!r.tags || r.tags.length === 0) untaggedCount++;
      }
    }
    return { success: true, data: { needsMigration: untaggedCount > 0, count: untaggedCount } };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

interface MigrationProgress {
  processed: number;
  total: number;
  currentBatch: number;
  totalBatches: number;
  isComplete: boolean;
  errors: string[];
}

let migrationProgress: MigrationProgress = {
  processed: 0,
  total: 0,
  currentBatch: 0,
  totalBatches: 0,
  isComplete: true,
  errors: [],
};

export async function handleGetTagMigrationProgress(): Promise<ApiResponse<MigrationProgress>> {
  return { success: true, data: migrationProgress };
}

export async function handleRunTagMigrationBatch(
  batchSize: number = 5
): Promise<ApiResponse<{ processed: number; total: number; hasMore: boolean }>> {
  try {
    const { AIProviderFactory } = await import("./ai/ai-provider-factory.js");
    const { buildMemoryProviderConfig } = await import("./ai/provider-config.js");
    const providerConfig = buildMemoryProviderConfig(CONFIG, {
      maxIterations: 1,
      iterationTimeout: 30000,
    });
    const provider = AIProviderFactory.createProvider(CONFIG.memoryProvider, providerConfig);

    const store = await getMemoryStore();
    const projectScopes = await store.listScopes("project");

    let batchProcessed = 0;
    const allMemories: { memory: MemoryRow; scope: ScopeKey }[] = [];

    for (const sk of projectScopes) {
      const rows = await store.list(sk, {});
      for (const m of rows) {
        allMemories.push({ memory: m, scope: sk });
      }
    }

    if (migrationProgress.total === 0) {
      migrationProgress.total = allMemories.length;
      migrationProgress.totalBatches = Math.ceil(allMemories.length / batchSize);
      migrationProgress.isComplete = false;
    }

    const startIdx = migrationProgress.processed;
    const endIdx = Math.min(startIdx + batchSize, allMemories.length);

    for (let i = startIdx; i < endIdx; i++) {
      const item = allMemories[i];
      if (!item) continue;
      const { memory: m, scope } = item;

      try {
        let currentTags = (m.tags ?? [])
          .map((t) => t.trim().toLowerCase())
          .filter((t) => t);

        if (currentTags.length === 0) {
          const prompt = `Generate 2-4 short technical tags for this memory content:\n\n${m.content}\n\nReturn ONLY a comma-separated list of tags.`;
          const result = await provider.executeToolCall(
            "You are a technical tagger.",
            prompt,
            {
              type: "function",
              function: {
                name: "save_tags",
                description: "Save generated tags",
                parameters: {
                  type: "object",
                  properties: { tags: { type: "array", items: { type: "string" } } },
                  required: ["tags"],
                },
              },
            },
            `migration_${m.id}`
          );
          if (result.success && result.data?.tags) {
            currentTags = result.data.tags;
          }
        }

        const vector = await embeddingService.embedWithTimeout(m.content);
        const tagsVector = currentTags.length
          ? await embeddingService.embedWithTimeout(currentTags.join(", "))
          : null;

        await store.update(scope, m.id, {
          tags: currentTags.length > 0 ? currentTags : null,
          vector,
          tagsVector,
          updatedAt: Date.now(),
        });

        migrationProgress.processed++;
        batchProcessed++;
      } catch (e) {
        const errorMsg = String(e);
        migrationProgress.errors.push(errorMsg);
        log("Migration error for memory", { id: m.id, error: errorMsg });
      }
    }

    migrationProgress.currentBatch++;
    const hasMore = migrationProgress.processed < migrationProgress.total;

    if (!hasMore) {
      migrationProgress.isComplete = true;
    }

    return {
      success: true,
      data: { processed: migrationProgress.processed, total: migrationProgress.total, hasMore },
    };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}
