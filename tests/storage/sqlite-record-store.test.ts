// tests/storage/sqlite-record-store.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let originalStoragePath: string | undefined;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ocmem-store-"));
  originalStoragePath = process.env.OPENCODE_MEM_STORAGE_PATH;
  process.env.OPENCODE_MEM_STORAGE_PATH = dir;
});

afterEach(() => {
  if (originalStoragePath === undefined) delete process.env.OPENCODE_MEM_STORAGE_PATH;
  else process.env.OPENCODE_MEM_STORAGE_PATH = originalStoragePath;
  rmSync(dir, { recursive: true, force: true });
});

test("SqliteRecordStore insert + getById round-trips a MemoryRow", async () => {
  const { SqliteRecordStore } = await import("../../src/services/storage/record-stores/sqlite-record-store.ts");
  const store = new SqliteRecordStore({ storagePath: dir, embeddingDimensions: 4 });
  await store.init();

  const scope = { scope: "user" as const, scopeHash: "abc" };
  const vector = new Float32Array([1, 0, 0, 0]);
  await store.insert(scope, {
    id: "m1",
    content: "hello",
    containerTag: "opencode-user",
    tags: ["greeting"],
    type: null,
    createdAt: 1000,
    updatedAt: 1000,
    metadata: { sessionID: "s1" },
    displayName: null,
    userName: null,
    userEmail: null,
    projectPath: null,
    projectName: null,
    gitRepoUrl: null,
    isPinned: false,
    vector,
    tagsVector: null,
  });

  const got = await store.getById(scope, "m1");
  expect(got).not.toBeNull();
  expect(got!.content).toBe("hello");
  expect(Array.from(got!.vector)).toEqual([1, 0, 0, 0]);
  expect(got!.metadata).toEqual({ sessionID: "s1" });
  expect(got!.tags).toEqual(["greeting"]);

  await store.close();
});

test("SqliteRecordStore iterateVectors streams every non-null row", async () => {
  const { SqliteRecordStore } = await import("../../src/services/storage/record-stores/sqlite-record-store.ts");
  const store = new SqliteRecordStore({ storagePath: dir, embeddingDimensions: 4 });
  await store.init();
  const scope = { scope: "user" as const, scopeHash: "abc" };

  for (const id of ["a", "b", "c"]) {
    await store.insert(scope, {
      id,
      content: id,
      containerTag: "t",
      tags: null,
      type: null,
      createdAt: 1,
      updatedAt: 1,
      metadata: null,
      displayName: null,
      userName: null,
      userEmail: null,
      projectPath: null,
      projectName: null,
      gitRepoUrl: null,
      isPinned: false,
      vector: new Float32Array([1, 0, 0, 0]),
      tagsVector: null,
    });
  }

  const ids: string[] = [];
  for await (const row of store.iterateVectors(scope, "content")) {
    ids.push(row.id);
  }
  expect(ids.sort()).toEqual(["a", "b", "c"]);

  await store.close();
});
