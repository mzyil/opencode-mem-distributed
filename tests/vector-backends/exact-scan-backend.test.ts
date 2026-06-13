import { describe, expect, it } from "bun:test";
import { ExactScanBackend } from "../../src/services/vector-backends/exact-scan-backend.js";
import type { NamespaceKey } from "../../src/services/vector-backends/types.js";

describe("ExactScanBackend", () => {
  it("returns nearest vectors in similarity order", () => {
    const backend = new ExactScanBackend();

    const rows = [
      { id: "a", vector: new Float32Array([1, 0, 0, 0]) },
      { id: "b", vector: new Float32Array([0, 1, 0, 0]) },
      { id: "c", vector: new Float32Array([0.9, 0.1, 0, 0]) },
    ];

    const result = backend.rankVectors(rows, new Float32Array([1, 0, 0, 0]), 2);

    expect(result.map((x) => x.id)).toEqual(["a", "c"]);
  });

  it("returns empty result for empty rows", () => {
    const backend = new ExactScanBackend();
    const result = backend.rankVectors([], new Float32Array([1, 0, 0, 0]), 5);
    expect(result).toEqual([]);
  });

  it("searches vectors from sqlite blobs in similarity order", async () => {
    const backend = new ExactScanBackend();
    const ns: NamespaceKey = {
      scope: "project",
      scopeHash: "hash",
      shardIndex: 0,
    };

    async function* source(): AsyncIterable<{ id: string; vector: Float32Array }> {
      yield { id: "a", vector: new Float32Array([1, 0, 0, 0]) };
      yield { id: "b", vector: new Float32Array([0, 1, 0, 0]) };
      yield { id: "c", vector: new Float32Array([0.9, 0.1, 0, 0]) };
    }

    await backend.rebuildFromSource({ ns, kind: "content", source: source() });

    const result = await backend.search({
      ns,
      kind: "content",
      queryVector: new Float32Array([1, 0, 0, 0]),
      limit: 2,
    });

    expect(result.map((x) => x.id)).toEqual(["a", "c"]);
  });

  it("returns empty search result when sqlite has no vectors", async () => {
    const backend = new ExactScanBackend();
    const ns: NamespaceKey = {
      scope: "project",
      scopeHash: "hash",
      shardIndex: 0,
    };

    async function* emptySource(): AsyncIterable<{ id: string; vector: Float32Array }> {
      // no rows
    }

    await backend.rebuildFromSource({ ns, kind: "content", source: emptySource() });

    const result = await backend.search({
      ns,
      kind: "content",
      queryVector: new Float32Array([1, 0, 0, 0]),
      limit: 2,
    });

    expect(result).toEqual([]);
  });
});
