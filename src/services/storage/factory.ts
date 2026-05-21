// src/services/storage/factory.ts
import { CONFIG } from "../../config.js";
import { log } from "../logger.js";
import { createVectorBackend } from "../vector-backends/backend-factory.js";
import { PgvectorBackend } from "../vector-backends/pgvector-backend.js";
import { MemoryStore } from "./memory-store.js";
import { LibsqlRecordStore } from "./record-stores/libsql-record-store.js";
import { PostgresRecordStore } from "./record-stores/postgres-record-store.js";
import { SqliteRecordStore } from "./record-stores/sqlite-record-store.js";
import type { RecordStore } from "./types.js";

type RsKind = "sqlite" | "postgres" | "libsql";
type VbKind = "usearch" | "exact-scan" | "pgvector";

const VALID_PAIRS: Record<RsKind, VbKind[]> = {
  sqlite: ["usearch", "exact-scan"],
  postgres: ["usearch", "exact-scan", "pgvector"],
  libsql: ["usearch", "exact-scan"],
};

export function validatePairing(rs: RsKind, vb: VbKind): void {
  if (!VALID_PAIRS[rs]?.includes(vb)) {
    throw new Error(
      `Invalid storage pairing: recordStore=${rs}, vectorBackend=${vb}. ` +
        `Valid for ${rs}: ${VALID_PAIRS[rs].join(", ")}`
    );
  }
}

export async function createMemoryStore(): Promise<MemoryStore> {
  const rsCfg = CONFIG.storage.recordStore;
  const vbCfg = CONFIG.storage.vectorBackend;

  validatePairing(rsCfg.kind as RsKind, vbCfg.kind as VbKind);

  // Special path: Postgres + Pgvector
  if (rsCfg.kind === "postgres" && vbCfg.kind === "pgvector") {
    if (!rsCfg.url) throw new Error("storage.recordStore.url is required for postgres");
    const rs = new PostgresRecordStore({
      url: rsCfg.url,
      ssl: rsCfg.ssl,
      poolSize: rsCfg.poolSize,
      omitVectorBytes: true,
    });
    try {
      await rs.init();
    } catch (err) {
      log("Postgres init failed; cannot use pgvector", { error: String(err) });
      throw err;
    }
    try {
      const vb = new PgvectorBackend({
        pool: rs.getPool(),
        dimensions: CONFIG.embeddingDimensions,
      });
      await vb.init();
      return new MemoryStore(rs, vb);
    } catch (err) {
      log("Pgvector unavailable; falling back to USearch", { error: String(err) });
      await rs.close();
      const rsFallback = new PostgresRecordStore({
        url: rsCfg.url,
        ssl: rsCfg.ssl,
        poolSize: rsCfg.poolSize,
        omitVectorBytes: false,
      });
      await rsFallback.init();
      const vb = await createVectorBackend({ vectorBackend: "usearch" });
      return new MemoryStore(rsFallback, vb);
    }
  }

  const recordStore = createRecordStore(rsCfg);
  await recordStore.init();

  const vectorBackend = await createVectorBackend({
    vectorBackend: vbCfg.kind === "exact-scan" ? "exact-scan" : "usearch",
  });
  return new MemoryStore(recordStore, vectorBackend);
}

function createRecordStore(cfg: typeof CONFIG.storage.recordStore): RecordStore {
  if (cfg.kind === "sqlite") {
    return new SqliteRecordStore({
      storagePath: CONFIG.storagePath,
      embeddingDimensions: CONFIG.embeddingDimensions,
    });
  }
  if (cfg.kind === "postgres") {
    if (!cfg.url) throw new Error("storage.recordStore.url is required for postgres");
    return new PostgresRecordStore({ url: cfg.url, ssl: cfg.ssl, poolSize: cfg.poolSize });
  }
  if (cfg.kind === "libsql") {
    if (!cfg.url) throw new Error("storage.recordStore.url is required for libsql");
    return new LibsqlRecordStore({ url: cfg.url, authToken: cfg.authToken });
  }
  throw new Error(`Unknown recordStore.kind: ${(cfg as { kind: string }).kind}`);
}
