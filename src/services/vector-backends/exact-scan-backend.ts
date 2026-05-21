import type {
  BackendInsertItem,
  BackendSearchResult,
  NamespaceKey,
  VectorBackend,
  VectorKind,
} from "./types.js";

interface RankedRow {
  id: string;
  vector: Float32Array;
}

export class ExactScanBackend implements VectorBackend {
  private readonly vectors = new Map<string, BackendInsertItem[]>();

  getBackendName(): string {
    return "exact-scan";
  }

  rankVectors(rows: RankedRow[], queryVector: Float32Array, limit: number): BackendSearchResult[] {
    return rows
      .map((row) => ({
        id: row.id,
        distance: 1 - this.cosineSimilarity(row.vector, queryVector),
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit);
  }

  async insert(args: {
    id: string;
    vector: Float32Array;
    ns: NamespaceKey;
    kind: VectorKind;
  }): Promise<void> {
    const key = this.getIndexKey(args.ns, args.kind);
    const buf = this.vectors.get(key) ?? [];
    const existing = buf.findIndex((item) => item.id === args.id);
    if (existing >= 0) {
      buf[existing] = { id: args.id, vector: args.vector };
    } else {
      buf.push({ id: args.id, vector: args.vector });
    }
    this.vectors.set(key, buf);
  }

  async insertBatch(args: {
    items: BackendInsertItem[];
    ns: NamespaceKey;
    kind: VectorKind;
  }): Promise<void> {
    for (const item of args.items) {
      await this.insert({ id: item.id, vector: item.vector, ns: args.ns, kind: args.kind });
    }
  }

  async delete(args: { id: string; ns: NamespaceKey; kind: VectorKind }): Promise<void> {
    const key = this.getIndexKey(args.ns, args.kind);
    const buf = this.vectors.get(key);
    if (!buf) return;
    const next = buf.filter((item) => item.id !== args.id);
    this.vectors.set(key, next);
  }

  async search(args: {
    ns: NamespaceKey;
    kind: VectorKind;
    queryVector: Float32Array;
    limit: number;
  }): Promise<BackendSearchResult[]> {
    const key = this.getIndexKey(args.ns, args.kind);
    const buf = this.vectors.get(key) ?? [];
    if (buf.length === 0) return [];
    return this.rankVectors(buf, args.queryVector, args.limit);
  }

  async rebuildFromSource(args: {
    ns: NamespaceKey;
    kind: VectorKind;
    source: AsyncIterable<{ id: string; vector: Float32Array }>;
  }): Promise<void> {
    const key = this.getIndexKey(args.ns, args.kind);
    const buf: BackendInsertItem[] = [];
    for await (const row of args.source) {
      if (row.vector.length > 0) buf.push(row);
    }
    this.vectors.set(key, buf);
  }

  async dropNamespace(args: { ns: NamespaceKey }): Promise<void> {
    for (const kind of ["content", "tags"] as const) {
      this.vectors.delete(this.getIndexKey(args.ns, kind));
    }
  }

  private getIndexKey(ns: NamespaceKey, kind: VectorKind): string {
    return `${ns.scope}_${ns.scopeHash}_${ns.shardIndex ?? "main"}_${kind}`;
  }

  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) {
      return 0;
    }

    let dot = 0;
    let magA = 0;
    let magB = 0;

    for (let i = 0; i < a.length; i++) {
      const av = a[i] ?? 0;
      const bv = b[i] ?? 0;
      dot += av * bv;
      magA += av * av;
      magB += bv * bv;
    }

    if (magA === 0 || magB === 0) {
      return 0;
    }

    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
  }
}
