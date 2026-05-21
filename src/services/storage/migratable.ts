// src/services/storage/migratable.ts
import type { MemoryRow, ScopeKey } from "./types.js";

export interface MigratableRow extends MemoryRow {
  scope: ScopeKey;
}

export interface Migratable {
  iterateAllRows(): AsyncIterable<MigratableRow>;
}
