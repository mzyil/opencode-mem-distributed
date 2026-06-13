import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NamespaceKey } from "../../src/services/vector-backends/types.js";
import { USearchBackend } from "../../src/services/vector-backends/usearch-backend.js";

describe("USearchBackend", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates and searches an in-memory index", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "usearch-backend-"));
    tempDirs.push(baseDir);

    const backend = new USearchBackend({ baseDir, dimensions: 4 });

    await backend.insertManyForTest("project_hash_0_content", [
      { id: "a", vector: new Float32Array([1, 0, 0, 0]) },
      { id: "b", vector: new Float32Array([0, 1, 0, 0]) },
      { id: "c", vector: new Float32Array([0.9, 0.1, 0, 0]) },
    ]);

    const result = await backend.searchForTest(
      "project_hash_0_content",
      new Float32Array([1, 0, 0, 0]),
      2
    );

    expect(result.map((x) => x.id)).toEqual(["a", "c"]);
  });

  it("supports public insert and search path", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "usearch-backend-public-"));
    tempDirs.push(baseDir);

    const ns: NamespaceKey = {
      scope: "project",
      scopeHash: "hash",
      shardIndex: 0,
    };

    const backend = new USearchBackend({ baseDir, dimensions: 4 });
    await backend.insert({
      id: "alpha",
      vector: new Float32Array([1, 0, 0, 0]),
      ns,
      kind: "content",
    });

    const result = await backend.search({
      ns,
      kind: "content",
      queryVector: new Float32Array([1, 0, 0, 0]),
      limit: 1,
    });

    expect(result.map((x) => x.id)).toEqual(["alpha"]);
  });

  it("updates an existing id instead of failing on duplicate insert", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "usearch-backend-upsert-"));
    tempDirs.push(baseDir);

    const ns: NamespaceKey = {
      scope: "project",
      scopeHash: "hash",
      shardIndex: 0,
    };

    const backend = new USearchBackend({ baseDir, dimensions: 4 });
    await backend.insert({
      id: "alpha",
      vector: new Float32Array([0, 1, 0, 0]),
      ns,
      kind: "content",
    });
    await backend.insert({
      id: "alpha",
      vector: new Float32Array([1, 0, 0, 0]),
      ns,
      kind: "content",
    });

    const result = await backend.search({
      ns,
      kind: "content",
      queryVector: new Float32Array([1, 0, 0, 0]),
      limit: 1,
    });

    expect(result.map((x) => x.id)).toEqual(["alpha"]);
  });

  it("rebuilds an index from sqlite rows", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "usearch-backend-rebuild-"));
    tempDirs.push(baseDir);

    const ns: NamespaceKey = {
      scope: "project",
      scopeHash: "hash",
      shardIndex: 0,
    };

    async function* source(): AsyncIterable<{ id: string; vector: Float32Array }> {
      yield { id: "alpha", vector: new Float32Array([1, 0, 0, 0]) };
    }

    const backend = new USearchBackend({ baseDir, dimensions: 4 });
    await backend.rebuildFromSource({ ns, kind: "content", source: source() });

    const result = await backend.search({
      ns,
      kind: "content",
      queryVector: new Float32Array([1, 0, 0, 0]),
      limit: 1,
    });

    expect(result.map((x) => x.id)).toEqual(["alpha"]);
  });
});
