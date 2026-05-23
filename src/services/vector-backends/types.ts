// src/services/vector-backends/types.ts
import type { Scope } from "../storage/types.js";

export type VectorKind = "content" | "tags";

export interface NamespaceKey {
  scope: Scope;
  scopeHash: string;
  shardIndex?: number; // SQLite-only; remote backends ignore
}

export interface BackendSearchResult {
  id: string;
  distance: number;
}

export interface BackendInsertItem {
  id: string;
  vector: Float32Array;
}

export interface VectorBackend {
  getBackendName(): string;

  insert(args: {
    id: string;
    vector: Float32Array;
    ns: NamespaceKey;
    kind: VectorKind;
  }): Promise<void>;
  insertBatch(args: {
    items: BackendInsertItem[];
    ns: NamespaceKey;
    kind: VectorKind;
  }): Promise<void>;
  delete(args: { id: string; ns: NamespaceKey; kind: VectorKind }): Promise<void>;

  search(args: {
    scopes: string[];
    kind: VectorKind;
    queryVector: Float32Array;
    limit: number;
  }): Promise<BackendSearchResult[]>;

  rebuildFromSource(args: {
    ns: NamespaceKey;
    kind: VectorKind;
    source: AsyncIterable<{ id: string; vector: Float32Array }>;
  }): Promise<void>;

  dropNamespace(args: { ns: NamespaceKey }): Promise<void>;
}

export interface VectorBackendFactoryOptions {
  vectorBackend: "usearch-first" | "usearch" | "exact-scan";
  probeUSearch?: () => Promise<boolean>;
  createUSearchBackend?: () => VectorBackend;
}
