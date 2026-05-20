// src/services/storage/factory.ts
import { CONFIG } from "../../config.js";
import { createVectorBackend } from "../vector-backends/backend-factory.js";
import { MemoryStore } from "./memory-store.js";
import { SqliteRecordStore } from "./record-stores/sqlite-record-store.js";
import type { RecordStore } from "./types.js";

export async function createMemoryStore(): Promise<MemoryStore> {
  const recordStore = createRecordStore();
  await recordStore.init();
  const vectorBackend = await createVectorBackend({ vectorBackend: CONFIG.vectorBackend });
  return new MemoryStore(recordStore, vectorBackend);
}

function createRecordStore(): RecordStore {
  // PR #1: only SQLite. PR #2 reads CONFIG.storage.recordStore and dispatches.
  return new SqliteRecordStore({
    storagePath: CONFIG.storagePath,
    embeddingDimensions: CONFIG.embeddingDimensions,
  });
}
