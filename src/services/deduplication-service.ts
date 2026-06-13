import { getMemoryStore } from "./storage/index.js";
import { CONFIG } from "../config.js";
import { log } from "./logger.js";
import type { MemoryRow, ScopeKey } from "./storage/types.js";

interface DuplicateGroup {
  representative: {
    id: string;
    content: string;
    containerTag: string;
    createdAt: number;
  };
  duplicates: Array<{
    id: string;
    content: string;
    similarity: number;
  }>;
}

interface DeduplicationResult {
  exactDuplicatesDeleted: number;
  nearDuplicateGroups: DuplicateGroup[];
}

export class DeduplicationService {
  private isRunning: boolean = false;

  async detectAndRemoveDuplicates(): Promise<DeduplicationResult> {
    if (this.isRunning) {
      throw new Error("Deduplication already running");
    }

    if (!CONFIG.deduplicationEnabled) {
      throw new Error("Deduplication is disabled in config");
    }

    this.isRunning = true;

    try {
      const store = await getMemoryStore();
      const userScopes = await store.listScopes("user");
      const projectScopes = await store.listScopes("project");
      const allScopes: ScopeKey[] = [...userScopes, ...projectScopes];

      let exactDeleted = 0;
      const nearDuplicateGroups: DuplicateGroup[] = [];

      for (const scope of allScopes) {
        const memories: MemoryRow[] = await store.list([scope.scope], {});

        const contentMap = new Map<string, MemoryRow[]>();

        for (const memory of memories) {
          const key = `${memory.containerTag}:${memory.content}`;
          if (!contentMap.has(key)) {
            contentMap.set(key, []);
          }
          contentMap.get(key)!.push(memory);
        }

        for (const [, duplicates] of contentMap) {
          if (duplicates.length > 1) {
            duplicates.sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
            const toDelete = duplicates.slice(1);

            for (const dup of toDelete) {
              try {
                await store.delete(scope, dup.id);
                exactDeleted++;
              } catch (error) {
                log("Deduplication: delete error", {
                  memoryId: dup.id,
                  error: String(error),
                });
              }
            }
          }
        }

        const uniqueMemories = Array.from(contentMap.values()).map((arr) => arr[0]);
        const processedIds = new Set<string>();

        for (let i = 0; i < uniqueMemories.length; i++) {
          const mem1 = uniqueMemories[i];
          if (!mem1 || !mem1.vector || mem1.vector.length === 0 || processedIds.has(mem1.id))
            continue;

          const vector1 = mem1.vector;
          const similarGroup: DuplicateGroup = {
            representative: {
              id: mem1.id,
              content: mem1.content,
              containerTag: mem1.containerTag,
              createdAt: mem1.createdAt,
            },
            duplicates: [],
          };

          for (let j = i + 1; j < uniqueMemories.length; j++) {
            const mem2 = uniqueMemories[j];
            if (!mem2 || !mem2.vector || mem2.vector.length === 0 || processedIds.has(mem2.id))
              continue;
            if (mem1.containerTag !== mem2.containerTag) continue;

            const vector2 = mem2.vector;
            const similarity = this.cosineSimilarity(vector1, vector2);

            if (similarity >= CONFIG.deduplicationSimilarityThreshold && similarity < 1.0) {
              similarGroup.duplicates.push({
                id: mem2.id,
                content: mem2.content,
                similarity,
              });
              processedIds.add(mem2.id);
            }
          }

          if (similarGroup.duplicates.length > 0) {
            nearDuplicateGroups.push(similarGroup);
          }
        }
      }

      return {
        exactDuplicatesDeleted: exactDeleted,
        nearDuplicateGroups,
      };
    } finally {
      this.isRunning = false;
    }
  }

  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      const aVal = a[i] || 0;
      const bVal = b[i] || 0;
      dotProduct += aVal * bVal;
      normA += aVal * aVal;
      normB += bVal * bVal;
    }

    if (normA === 0 || normB === 0) return 0;

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  getStatus() {
    return {
      enabled: CONFIG.deduplicationEnabled,
      threshold: CONFIG.deduplicationSimilarityThreshold,
      isRunning: this.isRunning,
    };
  }
}

export const deduplicationService = new DeduplicationService();
