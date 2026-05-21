import { Kysely } from "kysely";
import { FileMigrationProvider, Migrator, type MigrationResult } from "kysely/migration";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "../../../config.js";

export async function runMigrations(
  db: Kysely<any>,
  dialect: "postgres" | "libsql"
): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const migrationFolder = path.join(here, "kysely-migrations", dialect);
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({ fs, path, migrationFolder }),
  });
  // 0002_pgvector reads this inside up(); must be set before migrateToLatest.
  // Respect a pre-set value (used by tests that need a non-default dimension).
  if (process.env.OPENCODE_MEM_EMBEDDING_DIMS === undefined) {
    process.env.OPENCODE_MEM_EMBEDDING_DIMS = String(CONFIG.embeddingDimensions);
  }
  const { error, results } = await migrator.migrateToLatest();
  if (error) {
    const failed =
      results?.find((r: MigrationResult) => r.status === "Error")?.migrationName ?? "<unknown>";
    throw new Error(`Migration failed: ${failed}`, { cause: error });
  }
}
