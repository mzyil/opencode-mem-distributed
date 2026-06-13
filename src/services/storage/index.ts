// src/services/storage/index.ts
import { MemoryStore } from "./memory-store.js";
import { createMemoryStore } from "./factory.js";

export { MemoryStore } from "./memory-store.js";
export type { SearchResult } from "./memory-store.js";
export { createMemoryStore } from "./factory.js";
export type { MemoryRow, ScopeKey, Scope, ListOptions, RecordStore, TagsRow } from "./types.js";

let _instance: MemoryStore | null = null;

export async function getMemoryStore(): Promise<MemoryStore> {
  if (!_instance) _instance = await createMemoryStore();
  return _instance;
}

export async function resetMemoryStore(): Promise<void> {
  if (_instance) await _instance.close();
  _instance = null;
}
