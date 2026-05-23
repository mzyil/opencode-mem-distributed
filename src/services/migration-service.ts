import { shardManager } from "./sqlite/shard-manager.js";
import { connectionManager } from "./sqlite/connection-manager.js";
import { getMemoryStore } from "./storage/index.js";
import type { MemoryRow, ScopeKey } from "./storage/types.js";
import { embeddingService } from "./embedding.js";
import { CONFIG } from "../config.js";
import { log } from "./logger.js";

// TODO(pr-2): remove direct shardManager / connectionManager access.
// This service does v1->v2 schema/dimension migration over the legacy
// SQLite shard layout (reads shard_metadata, deletes shard files).
// Those operations have no MemoryStore equivalent yet.

export interface DimensionMismatch {
  needsMigration: boolean;
  configDimensions: number;
  configModel: string;
  shardMismatches: Array<{
    shardId: number;
    dbPath: string;
    storedDimensions: number;
    storedModel: string;
    vectorCount: number;
    scope: string;
    scopeHash: string;
  }>;
}

export interface MigrationProgress {
  phase: "preparing" | "re-embedding" | "cleanup" | "complete";
  processed: number;
  total: number;
  currentShard?: string;
}

export interface MigrationResult {
  success: boolean;
  strategy: "fresh-start" | "re-embed";
  deletedShards: number;
  reEmbeddedMemories: number;
  duration: number;
  error?: string;
}

export class MigrationService {
  private isRunning: boolean = false;
  private progressCallback?: (progress: MigrationProgress) => void;

  async detectDimensionMismatch(): Promise<DimensionMismatch> {
    // TODO(pr-2): expose shard metadata through MemoryStore so this
    // can drop the direct shardManager dependency.
    const userShards = shardManager.getAllShards("user", "");
    const projectShards = shardManager.getAllShards("project", "");
    const allShards = [...userShards, ...projectShards];

    const mismatches: DimensionMismatch["shardMismatches"] = [];

    for (const shard of allShards) {
      try {
        const db = connectionManager.getConnection(shard.dbPath);

        const metadataResult = db
          .prepare(
            `
          SELECT key, value FROM shard_metadata
          WHERE key IN ('embedding_dimensions', 'embedding_model')
        `
          )
          .all() as Array<{ key: string; value: string }>;

        const metadata = Object.fromEntries(metadataResult.map((row) => [row.key, row.value]));

        const storedDimensions = parseInt(metadata.embedding_dimensions || "0");
        const storedModel = metadata.embedding_model || "unknown";

        if (storedDimensions !== CONFIG.embeddingDimensions) {
          const countRow: any = db.prepare(`SELECT COUNT(*) AS c FROM memories`).get();
          const vectorCount = countRow?.c ?? 0;

          mismatches.push({
            shardId: shard.id,
            dbPath: shard.dbPath,
            storedDimensions,
            storedModel,
            vectorCount,
            scope: shard.scope,
            scopeHash: shard.scopeHash,
          });
        }
      } catch (error) {
        log("Migration: error checking shard", {
          shardId: shard.id,
          error: String(error),
        });
      }
    }

    return {
      needsMigration: mismatches.length > 0,
      configDimensions: CONFIG.embeddingDimensions,
      configModel: CONFIG.embeddingModel,
      shardMismatches: mismatches,
    };
  }

  async migrateToNewModel(
    strategy: "fresh-start" | "re-embed",
    progressCallback?: (progress: MigrationProgress) => void
  ): Promise<MigrationResult> {
    if (this.isRunning) {
      throw new Error("Migration already running");
    }

    this.isRunning = true;
    this.progressCallback = progressCallback;
    const startTime = Date.now();

    try {
      const mismatch = await this.detectDimensionMismatch();

      if (!mismatch.needsMigration) {
        return {
          success: true,
          strategy,
          deletedShards: 0,
          reEmbeddedMemories: 0,
          duration: Date.now() - startTime,
        };
      }

      if (strategy === "fresh-start") {
        return await this.freshStartMigration(mismatch, startTime);
      } else {
        return await this.reEmbedMigration(mismatch, startTime);
      }
    } catch (error) {
      log("Migration: failed", { error: String(error) });
      return {
        success: false,
        strategy,
        deletedShards: 0,
        reEmbeddedMemories: 0,
        duration: Date.now() - startTime,
        error: String(error),
      };
    } finally {
      this.isRunning = false;
      this.progressCallback = undefined;
    }
  }

  private async freshStartMigration(
    mismatch: DimensionMismatch,
    startTime: number
  ): Promise<MigrationResult> {
    this.reportProgress({
      phase: "preparing",
      processed: 0,
      total: mismatch.shardMismatches.length,
    });

    let deletedShards = 0;

    for (const [index, shardInfo] of mismatch.shardMismatches.entries()) {
      try {
        this.reportProgress({
          phase: "cleanup",
          processed: index,
          total: mismatch.shardMismatches.length,
          currentShard: String(shardInfo.shardId),
        });

        // TODO(pr-2): MemoryStore has no shard-delete primitive (SQLite-specific).
        await shardManager.deleteShard(shardInfo.shardId);
        deletedShards++;
      } catch (error) {
        log("Migration: error deleting shard", {
          shardId: shardInfo.shardId,
          error: String(error),
        });
      }
    }

    this.reportProgress({
      phase: "complete",
      processed: mismatch.shardMismatches.length,
      total: mismatch.shardMismatches.length,
    });

    return {
      success: true,
      strategy: "fresh-start",
      deletedShards,
      reEmbeddedMemories: 0,
      duration: Date.now() - startTime,
    };
  }

  private async reEmbedMigration(
    mismatch: DimensionMismatch,
    startTime: number
  ): Promise<MigrationResult> {
    await embeddingService.warmup();
    embeddingService.clearCache();

    const totalMemories = mismatch.shardMismatches.reduce((sum, s) => sum + s.vectorCount, 0);

    this.reportProgress({
      phase: "preparing",
      processed: 0,
      total: totalMemories,
    });

    let reEmbeddedCount = 0;
    let processedCount = 0;

    const store = await getMemoryStore();

    for (const shardInfo of mismatch.shardMismatches) {
      this.reportProgress({
        phase: "re-embedding",
        processed: processedCount,
        total: totalMemories,
        currentShard: String(shardInfo.shardId),
      });

      try {
        // Read every memory out of the legacy shard directly. We can't
        // use store.list() here because it spans every shard in the
        // scope and we only want to migrate this one shard's rows
        // before deleting it.
        const db = connectionManager.getConnection(shardInfo.dbPath);
        const rawRows = db.prepare(`SELECT * FROM memories`).all() as any[];

        type TempMemory = {
          id: string;
          content: string;
          containerTag: string;
          type: string | null;
          createdAt: number;
          updatedAt: number;
          metadata: Record<string, unknown> | null;
          displayName: string | null;
          userName: string | null;
          userEmail: string | null;
          projectPath: string | null;
          projectName: string | null;
          gitRepoUrl: string | null;
          tags: string[] | null;
          isPinned: boolean;
        };
        const tempMemories: TempMemory[] = rawRows.map((row) => ({
          id: row.id,
          content: row.content,
          containerTag: row.container_tag,
          type: row.type ?? null,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          metadata: row.metadata
            ? (() => {
                try {
                  return JSON.parse(row.metadata);
                } catch {
                  return null;
                }
              })()
            : null,
          displayName: row.display_name ?? null,
          userName: row.user_name ?? null,
          userEmail: row.user_email ?? null,
          projectPath: row.project_path ?? null,
          projectName: row.project_name ?? null,
          gitRepoUrl: row.git_repo_url ?? null,
          tags: row.tags
            ? String(row.tags)
                .split(",")
                .map((t: string) => t.trim())
                .filter((t: string) => t)
            : null,
          isPinned: row.is_pinned === 1,
        }));

        // TODO(pr-2): no MemoryStore equivalent for shard deletion.
        await shardManager.deleteShard(shardInfo.shardId);

        const scope: ScopeKey = { scope: shardInfo.scope, scopeHash: shardInfo.scopeHash };

        for (const memory of tempMemories) {
          try {
            const vector = await embeddingService.embedWithTimeout(memory.content);
            const tagsVector =
              memory.tags && memory.tags.length > 0
                ? await embeddingService.embedWithTimeout(memory.tags.join(", "))
                : null;

            const row: MemoryRow = {
              id: memory.id,
              content: memory.content,
              containerTag: memory.containerTag,
              tags: memory.tags,
              type: memory.type,
              createdAt: memory.createdAt,
              updatedAt: memory.updatedAt,
              metadata: memory.metadata,
              displayName: memory.displayName,
              userName: memory.userName,
              userEmail: memory.userEmail,
              projectPath: memory.projectPath,
              projectName: memory.projectName,
              gitRepoUrl: memory.gitRepoUrl,
              isPinned: memory.isPinned,
              vector,
              tagsVector,
            };

            await store.insert(scope, row);

            if (memory.isPinned) {
              await store.setPinned(scope, memory.id, true);
            }

            reEmbeddedCount++;
            processedCount++;

            this.reportProgress({
              phase: "re-embedding",
              processed: processedCount,
              total: totalMemories,
              currentShard: String(shardInfo.shardId),
            });
          } catch (error) {
            log("Migration: error re-embedding memory", {
              memoryId: memory.id,
              error: String(error),
            });
            processedCount++;
          }
        }
      } catch (error) {
        log("Migration: error processing shard", {
          shardId: shardInfo.shardId,
          error: String(error),
        });
      }
    }

    this.reportProgress({
      phase: "complete",
      processed: totalMemories,
      total: totalMemories,
    });

    return {
      success: true,
      strategy: "re-embed",
      deletedShards: mismatch.shardMismatches.length,
      reEmbeddedMemories: reEmbeddedCount,
      duration: Date.now() - startTime,
    };
  }

  private reportProgress(progress: MigrationProgress): void {
    if (this.progressCallback) {
      this.progressCallback(progress);
    }
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      configModel: CONFIG.embeddingModel,
      configDimensions: CONFIG.embeddingDimensions,
    };
  }
}

export const migrationService = new MigrationService();
