import type {
  BackendInsertItem,
  BackendSearchResult,
  NamespaceKey,
  VectorBackend,
  VectorKind,
} from "./types.js";

type USearchModule = typeof import("usearch");
type USearchIndex = InstanceType<USearchModule["Index"]>;

interface CachedIndex {
  index: USearchIndex;
  idToKey: Map<string, bigint>;
  keyToId: Map<bigint, string>;
  nextKey: bigint;
  indexKey: string;
  initialized: boolean;
}

export class USearchBackend implements VectorBackend {
  private readonly indexes = new Map<string, CachedIndex>();

  constructor(
    private readonly options: {
      baseDir: string;
      dimensions: number;
    }
  ) {
    void this.options.baseDir;
  }

  getBackendName(): string {
    return "usearch";
  }

  async insert(args: {
    id: string;
    vector: Float32Array;
    ns: NamespaceKey;
    kind: VectorKind;
  }): Promise<void> {
    const indexKey = this.getIndexKey(args.ns, args.kind);
    const cache = await this.getOrCreateIndex(indexKey);
    try {
      this.upsertItem(cache, { id: args.id, vector: args.vector });
      cache.initialized = true;
    } catch (error) {
      throw new Error(`USearch insert failed for ${indexKey}: ${String(error)}`);
    }
  }

  async insertBatch(args: {
    items: BackendInsertItem[];
    ns: NamespaceKey;
    kind: VectorKind;
  }): Promise<void> {
    const indexKey = this.getIndexKey(args.ns, args.kind);
    const cache = await this.getOrCreateIndex(indexKey);
    try {
      this.addItems(cache, args.items);
      cache.initialized = true;
    } catch (error) {
      throw new Error(`USearch batch insert failed for ${indexKey}: ${String(error)}`);
    }
  }

  async delete(args: { id: string; ns: NamespaceKey; kind: VectorKind }): Promise<void> {
    const cache = await this.getOrCreateIndex(this.getIndexKey(args.ns, args.kind));
    const key = cache.idToKey.get(args.id);
    if (key === undefined) return;
    cache.index.remove(key);
    cache.idToKey.delete(args.id);
    cache.keyToId.delete(key);
  }

  async search(args: {
    ns: NamespaceKey;
    kind: VectorKind;
    queryVector: Float32Array;
    limit: number;
  }): Promise<BackendSearchResult[]> {
    const indexKey = this.getIndexKey(args.ns, args.kind);
    const cache = await this.getOrCreateIndex(indexKey);
    try {
      const matches = cache.index.search(args.queryVector, args.limit);
      return Array.from(matches.keys as Iterable<bigint>, (key, index) => {
        const id = cache.keyToId.get(key);
        if (!id) {
          throw new Error(
            `USearch index metadata missing for key ${String(key)} in ${cache.indexKey}`
          );
        }
        return {
          id,
          distance: matches.distances[index] ?? 0,
        };
      });
    } catch (error) {
      throw new Error(`USearch search failed for ${indexKey}: ${String(error)}`);
    }
  }

  async rebuildFromSource(args: {
    ns: NamespaceKey;
    kind: VectorKind;
    source: AsyncIterable<{ id: string; vector: Float32Array }>;
  }): Promise<void> {
    const indexKey = this.getIndexKey(args.ns, args.kind);
    const existing = this.indexes.get(indexKey);
    if (existing?.initialized) return;

    const cache = await this.createEmptyIndex(indexKey);
    this.indexes.set(indexKey, cache);

    for await (const row of args.source) {
      if (row.vector.length === 0) continue;
      this.upsertItem(cache, { id: row.id, vector: row.vector });
    }
    cache.initialized = true;
  }

  async dropNamespace(args: { ns: NamespaceKey }): Promise<void> {
    for (const kind of ["content", "tags"] as const) {
      this.indexes.delete(this.getIndexKey(args.ns, kind));
    }
  }

  async insertManyForTest(indexKey: string, items: BackendInsertItem[]): Promise<void> {
    const cache = await this.getOrCreateIndex(indexKey);
    this.addItems(cache, items);
    cache.initialized = true;
  }

  async searchForTest(
    indexKey: string,
    queryVector: Float32Array,
    limit: number
  ): Promise<BackendSearchResult[]> {
    const cache = await this.getOrCreateIndex(indexKey);
    try {
      const matches = cache.index.search(queryVector, limit);
      return Array.from(matches.keys as Iterable<bigint>, (key, index) => {
        const id = cache.keyToId.get(key);
        if (!id) {
          throw new Error(
            `USearch index metadata missing for key ${String(key)} in ${cache.indexKey}`
          );
        }
        return {
          id,
          distance: matches.distances[index] ?? 0,
        };
      });
    } catch (error) {
      throw new Error(`USearch test search failed for ${indexKey}: ${String(error)}`);
    }
  }

  private async getOrCreateIndex(indexKey: string): Promise<CachedIndex> {
    const existing = this.indexes.get(indexKey);
    if (existing) return existing;

    const cache = await this.createEmptyIndex(indexKey);
    this.indexes.set(indexKey, cache);
    return cache;
  }

  private async createEmptyIndex(indexKey: string): Promise<CachedIndex> {
    const usearch = await this.loadUSearch();
    return {
      index: new usearch.Index({ dimensions: this.options.dimensions, metric: "cos" }),
      idToKey: new Map(),
      keyToId: new Map(),
      nextKey: 1n,
      indexKey,
      initialized: false,
    };
  }

  private ensureKey(cache: CachedIndex, id: string): bigint {
    const existing = cache.idToKey.get(id);
    if (existing !== undefined) return existing;

    const key = cache.nextKey;
    cache.nextKey += 1n;
    cache.idToKey.set(id, key);
    cache.keyToId.set(key, id);
    return key;
  }

  private addItems(cache: CachedIndex, items: BackendInsertItem[]): void {
    for (const item of items) {
      this.upsertItem(cache, item);
    }
  }

  private upsertItem(cache: CachedIndex, item: BackendInsertItem): void {
    const existing = cache.idToKey.get(item.id);
    if (existing !== undefined) {
      cache.index.remove(existing);
    }
    const key = this.ensureKey(cache, item.id);
    cache.index.add(key, item.vector);
  }

  private getIndexKey(ns: NamespaceKey, kind: VectorKind): string {
    return `${ns.scope}_${ns.scopeHash}_${ns.shardIndex ?? "main"}_${kind}`;
  }

  private async loadUSearch(): Promise<USearchModule> {
    try {
      return await import("usearch");
    } catch (error) {
      throw new Error(`Failed to load usearch backend: ${String(error)}`);
    }
  }
}
