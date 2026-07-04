import { Kysely } from "kysely";
import { FileMigrationProvider, Migrator, type MigrationResult } from "kysely/migration";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "../../../config.js";
import { formatError } from "../../logger.js";

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
    // Kysely returns errors here rather than throwing. `results` is populated only when a
    // migration body failed; a SETUP-phase failure (DB connect, creating the migration
    // bookkeeping tables, lock acquisition, reading the migration folder) leaves `results`
    // undefined. Distinguish the two and ALWAYS carry the real error as `cause` — the old
    // code interpolated only the migration name, so setup failures printed the useless
    // "Migration failed: <unknown>" that masked errors like `getaddrinfo ENOTFOUND`.
    const failed = results?.find((r: MigrationResult) => r.status === "Error")?.migrationName;
    const where = failed
      ? `migration ${failed}`
      : "migration setup (connect / bookkeeping tables / lock / migration folder)";
    throw new Error(`Migration failed at ${where}: ${formatError(error)}`, { cause: error });
  }
}
