#!/usr/bin/env -S bun run
// src/services/storage/migrate-cli.ts
import { CONFIG } from "../../config.js";
import { PgvectorBackend } from "../vector-backends/pgvector-backend.js";
import type { Migratable, MigratableRow } from "./migratable.js";
import { LibsqlRecordStore } from "./record-stores/libsql-record-store.js";
import { PostgresRecordStore } from "./record-stores/postgres-record-store.js";
import { SqliteRecordStore } from "./record-stores/sqlite-record-store.js";
import type { RecordStore } from "./types.js";

export interface MigrateOptions {
  to: "postgres" | "libsql";
  url: string;
  vectorBackend: "exact-scan" | "usearch" | "pgvector";
  batchSize: number;
  dryRun: boolean;
  // "all" is the explicit "no filter" sentinel; any other string is a free-form
  // scope label that must match the row's scope column exactly.
  scope: "all" | (string & {});
  resume: boolean;
  authToken?: string;
  ssl?: boolean;
  source?: RecordStore & Migratable;
}

export interface MigrateSummary {
  inserted: number;
  skipped: number;
  failed: number;
}

export async function runMigrate(opts: MigrateOptions): Promise<MigrateSummary> {
  const source: RecordStore & Migratable =
    opts.source ??
    new SqliteRecordStore({
      storagePath: CONFIG.storagePath,
      embeddingDimensions: CONFIG.embeddingDimensions,
    });

  // Only init when we created it ourselves; injected sources are already initialised.
  if (!opts.source) {
    await source.init();
  }

  let target: RecordStore;
  const usePgvector = opts.to === "postgres" && opts.vectorBackend === "pgvector";
  if (opts.to === "postgres") {
    target = new PostgresRecordStore({
      url: opts.url,
      ssl: opts.ssl,
      omitVectorBytes: usePgvector,
    });
  } else if (opts.to === "libsql") {
    target = new LibsqlRecordStore({ url: opts.url, authToken: opts.authToken });
  } else {
    throw new Error(`Unknown migration target: ${opts.to}`);
  }
  await target.init();

  let vb: PgvectorBackend | null = null;
  if (usePgvector) {
    const pgTarget = target as PostgresRecordStore;
    vb = new PgvectorBackend({
      pool: pgTarget.getPool(),
      dimensions: CONFIG.embeddingDimensions,
    });
    try {
      await vb.init();
    } catch (err) {
      console.error("[migrate] pgvector extension unavailable on target; aborting:", err);
      throw err;
    }
  }

  let inserted = 0;
  let skipped = 0;
  let failed = 0;
  let lastLog = Date.now();

  const log = (force = false) => {
    const now = Date.now();
    if (force || now - lastLog >= 1000) {
      console.log(`[migrate] inserted=${inserted} skipped=${skipped} failed=${failed}`);
      lastLog = now;
    }
  };

  try {
    for await (const r of source.iterateAllRows() as AsyncIterable<MigratableRow>) {
      if (opts.scope !== "all" && r.scope.scope !== opts.scope) {
        continue;
      }
      const { scope, ...memoryRow } = r;
      try {
        if (opts.resume) {
          // TODO(perf): per-row getById is O(N) round-trips. For huge migrations,
          // switch to RecordStore.insertIgnoreConflict (dialect ON CONFLICT DO NOTHING).
          const existing = await target.getById(scope, memoryRow.id);
          if (existing) {
            skipped++;
            log();
            continue;
          }
        }
        if (opts.dryRun) {
          // Count would-be inserts as "inserted" for visibility.
          inserted++;
          log();
          continue;
        }
        await target.insert(scope, memoryRow);
        inserted++;
        if (vb && !opts.dryRun) {
          const ns = { scope: scope.scope, scopeHash: scope.scopeHash };
          try {
            await vb.insert({ id: memoryRow.id, vector: memoryRow.vector, ns, kind: "content" });
            if (memoryRow.tagsVector) {
              await vb.insert({
                id: memoryRow.id,
                vector: memoryRow.tagsVector,
                ns,
                kind: "tags",
              });
            }
          } catch (vbErr) {
            // memories row landed but pgvector side failed. Counted as a failure here;
            // note: re-running with --resume currently skips both inserts when the memories
            // row exists, so pgvector orphans are not back-filled by --resume in v1.
            failed++;
            inserted--;
            console.error(
              `[migrate] pgvector insert failed id=${memoryRow.id}:`,
              vbErr instanceof Error ? vbErr.message : vbErr
            );
          }
        }
      } catch (err) {
        // Idempotent best-effort: if the row already exists, skip silently.
        const existing = await target.getById(scope, memoryRow.id).catch(() => null);
        if (existing) {
          skipped++;
        } else {
          failed++;

          console.error(
            `[migrate] failed id=${memoryRow.id} scope=${scope.scope}/${scope.scopeHash}:`,
            err instanceof Error ? err.message : err
          );
        }
      }
      log();
    }
    log(true);
  } finally {
    await target.close().catch(() => {});
    if (!opts.source) {
      await source.close().catch(() => {});
    }
  }

  return { inserted, skipped, failed };
}

function printUsage(): void {
  console.log(
    `Usage: opencode-mem-migrate --to <postgres|libsql> --url <connection-url> [options]

Options:
  --to <postgres|libsql>        Migration target (required)
  --url <url>                   Target connection URL (required)
  --vector-backend <kind>       exact-scan | usearch | pgvector (default: exact-scan)
  --batch-size <n>              Batch size (default: 500)
  --scope <all|user|project>    Scope filter (default: all)
  --dry-run                     Don't actually insert
  --resume                      Skip rows that already exist on target
  --auth-token <token>          libSQL auth token
  --ssl                         Enable SSL for postgres
  --help                        Show this message`
  );
}

function parseArgs(argv: string[]): Partial<MigrateOptions> & { help?: boolean } {
  const out: Partial<MigrateOptions> & { help?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--to":
        out.to = next() as MigrateOptions["to"];
        break;
      case "--url":
        out.url = next();
        break;
      case "--vector-backend":
        out.vectorBackend = next() as MigrateOptions["vectorBackend"];
        break;
      case "--batch-size":
        out.batchSize = Number(next());
        break;
      case "--scope":
        out.scope = next() as MigrateOptions["scope"];
        break;
      case "--dry-run":
        out.dryRun = true;
        break;
      case "--resume":
        out.resume = true;
        break;
      case "--auth-token":
        out.authToken = next();
        break;
      case "--ssl":
        out.ssl = true;
        break;
      case "--help":
      case "-h":
        out.help = true;
        break;
      default:
        // unknown flag — ignored
        break;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.to || !args.url) {
    printUsage();
    process.exit(args.help ? 0 : 1);
  }

  const summary = await runMigrate({
    to: args.to,
    url: args.url,
    vectorBackend: args.vectorBackend ?? "exact-scan",
    batchSize: args.batchSize ?? 500,
    dryRun: args.dryRun ?? false,
    scope: args.scope ?? "all",
    resume: args.resume ?? false,
    authToken: args.authToken,
    ssl: args.ssl,
  });

  console.log(
    `[migrate] done inserted=${summary.inserted} skipped=${summary.skipped} failed=${summary.failed}`
  );
  if (summary.failed > 0) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
