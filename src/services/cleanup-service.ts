import { getMemoryStore } from "./storage/index.js";
import type { MemoryRow, ScopeKey } from "./storage/types.js";
import { CONFIG } from "../config.js";
import { log } from "./logger.js";
import { userPromptManager } from "./user-prompt/user-prompt-manager.js";

interface CleanupResult {
  deletedCount: number;
  userCount: number;
  projectCount: number;
  promptsDeleted: number;
  linkedMemoriesDeleted: number;
  pinnedMemoriesSkipped: number;
}

export class CleanupService {
  private lastCleanupTime: number = 0;
  private isRunning: boolean = false;

  async shouldRunCleanup(): Promise<boolean> {
    if (!CONFIG.autoCleanupEnabled) return false;
    if (this.isRunning) return false;

    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;

    if (now - this.lastCleanupTime < oneDayMs) {
      return false;
    }

    return true;
  }

  async runCleanup(): Promise<CleanupResult> {
    if (this.isRunning) {
      throw new Error("Cleanup already running");
    }

    this.isRunning = true;
    this.lastCleanupTime = Date.now();

    try {
      const cutoffTime = Date.now() - CONFIG.autoCleanupRetentionDays * 24 * 60 * 60 * 1000;

      const store = await getMemoryStore();
      const userScopes = await store.listScopes("user");
      const projectScopes = await store.listScopes("project");
      const allScopes: ScopeKey[] = [...userScopes, ...projectScopes];

      // Collect every memory per-scope once; we need both pinned IDs
      // and the full row set to filter by updatedAt < cutoff.
      const memoriesByScope = new Map<ScopeKey, MemoryRow[]>();
      const pinnedMemoryIds = new Set<string>();
      for (const scope of allScopes) {
        const rows = await store.list(scope, {});
        memoriesByScope.set(scope, rows);
        for (const r of rows) {
          if (r.isPinned) pinnedMemoryIds.add(r.id);
        }
      }

      const promptCleanupResult = userPromptManager.deleteOldPrompts(cutoffTime);
      const linkedMemoryIds = new Set(promptCleanupResult.linkedMemoryIds);

      const protectedMemoryIds = new Set([...pinnedMemoryIds, ...linkedMemoryIds]);

      let totalDeleted = 0;
      let userDeleted = 0;
      let projectDeleted = 0;
      let linkedMemoriesDeleted = 0;
      let pinnedSkipped = 0;

      for (const [scope, rows] of memoriesByScope) {
        const oldMemories = rows.filter((r) => r.updatedAt < cutoffTime);

        for (const memory of oldMemories) {
          try {
            if (memory.isPinned) {
              pinnedSkipped++;
              continue;
            }

            if (protectedMemoryIds.has(memory.id)) {
              continue;
            }

            await store.delete(scope, memory.id);
            totalDeleted++;

            if (memory.containerTag?.includes("_user_")) {
              userDeleted++;
            } else if (memory.containerTag?.includes("_project_")) {
              projectDeleted++;
            }
          } catch (error) {
            log("Cleanup: delete error", { memoryId: memory.id, error: String(error) });
          }
        }
      }

      const promptsDeleted = promptCleanupResult.deleted - linkedMemoryIds.size;

      return {
        deletedCount: totalDeleted,
        userCount: userDeleted,
        projectCount: projectDeleted,
        promptsDeleted,
        linkedMemoriesDeleted,
        pinnedMemoriesSkipped: pinnedSkipped,
      };
    } finally {
      this.isRunning = false;
    }
  }

  getStatus() {
    return {
      enabled: CONFIG.autoCleanupEnabled,
      retentionDays: CONFIG.autoCleanupRetentionDays,
      lastCleanupTime: this.lastCleanupTime,
      isRunning: this.isRunning,
    };
  }
}

export const cleanupService = new CleanupService();
