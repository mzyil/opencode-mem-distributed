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
  // 0002_pgvector reads this at module load; must be set before migrateToLatest
  process.env.OPENCODE_MEM_EMBEDDING_DIMS = String(CONFIG.embeddingDimensions);
  const { error, results } = await migrator.migrateToLatest();
  if (error) {
    const failed =
      results?.find((r: MigrationResult) => r.status === "Error")?.migrationName ?? "<unknown>";
    throw new Error(`Migration failed: ${failed}`, { cause: error });
  }
}
