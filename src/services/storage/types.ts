// src/services/storage/types.ts

// Free-form scope label. By convention, "<domain>:<type>:<id>" — see README.
// Empty string is reserved as an internal sentinel meaning "no scope filter applied".
export type Scope = string;

export interface ScopeKey {
  scope: Scope;
  scopeHash: string;
}

export interface TagsRow {
  containerTag: string;
  displayName: string | null;
  userName: string | null;
  userEmail: string | null;
  projectPath: string | null;
  projectName: string | null;
  gitRepoUrl: string | null;
}

export interface MemoryRow {
  id: string;
  content: string;
  containerTag: string;
  tags: string[] | null;
  type: string | null;
  createdAt: number; // Date.now() ms
  updatedAt: number;
  metadata: Record<string, unknown> | null;
  displayName: string | null;
  userName: string | null;
  userEmail: string | null;
  projectPath: string | null;
  projectName: string | null;
  gitRepoUrl: string | null;
  isPinned: boolean;
  vector: Float32Array;
  tagsVector: Float32Array | null;
}

export interface ListOptions {
  containerTag?: string; // "" means all
  limit?: number;
  sessionId?: string;
}

export interface RecordStore {
  init(): Promise<void>;
  close(): Promise<void>;

  insert(scope: ScopeKey, row: MemoryRow): Promise<void>;
  update(scope: ScopeKey, id: string, patch: Partial<MemoryRow>): Promise<void>;
  delete(scope: ScopeKey, id: string): Promise<void>;
  getById(scope: ScopeKey, id: string): Promise<MemoryRow | null>;

  list(scope: ScopeKey, opts: ListOptions): Promise<MemoryRow[]>;
  countByContainer(scope: ScopeKey, containerTag: string): Promise<number>;
  countAll(scope: ScopeKey): Promise<number>;
  distinctTags(scope: ScopeKey): Promise<TagsRow[]>;

  getByIds(scope: ScopeKey, ids: string[], containerTag: string): Promise<MemoryRow[]>;
  iterateVectors(
    scope: ScopeKey,
    kind: "content" | "tags"
  ): AsyncIterable<{ id: string; vector: Float32Array }>;

  setPinned(scope: ScopeKey, id: string, pinned: boolean): Promise<void>;
  // Legacy scope enumeration kept for back-compat with old data shapes.
  // New callers should use list-by-prefix or scope-array reads instead.
  listScopes(legacyScopeKind: "user" | "project"): Promise<ScopeKey[]>;
}
