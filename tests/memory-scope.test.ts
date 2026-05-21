import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];
const clientUrl = new URL("../src/services/client.js", import.meta.url).href;
const storageUrl = new URL("../src/services/storage/index.js", import.meta.url).href;
const embeddingUrl = new URL("../src/services/embedding.js", import.meta.url).href;

function runScenario(scriptBody: string) {
  const dir = mkdtempSync(join(tmpdir(), "opencode-mem-memory-scope-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "scenario.mjs");
  const script = `
import { mock } from "bun:test";

// Two "project" scopes simulate the previous two-shard fixture; each
// returns a single memory tagged by its scope hash. The single-scope
// path (default project) returns one row.
const projectScopes = [
  { scope: "project", scopeHash: "shard-a" },
  { scope: "project", scopeHash: "shard-b" },
];

function rowFor(scopeHash) {
  return {
    id: scopeHash,
    content: scopeHash.toUpperCase(),
    containerTag: "tag-" + scopeHash.slice(-1),
    tags: null,
    type: null,
    createdAt: scopeHash === "shard-a" ? 2 : scopeHash === "shard-b" ? 1 : 3,
    updatedAt: 0,
    metadata: null,
    displayName: null,
    userName: null,
    userEmail: null,
    projectPath: null,
    projectName: null,
    gitRepoUrl: null,
    isPinned: false,
    vector: new Float32Array([1, 2, 3]),
    tagsVector: null,
  };
}

mock.module(${JSON.stringify(embeddingUrl)}, () => ({
  embeddingService: {
    isWarmedUp: true,
    warmup: async () => {},
    embedWithTimeout: async () => new Float32Array([1, 2, 3]),
  },
}));

mock.module(${JSON.stringify(storageUrl)}, () => {
  const fakeStore = {
    async init() {},
    async close() {},
    async listScopes(kind) {
      return kind === "project" ? projectScopes : [];
    },
    async list(scope) {
      // Single-scope (default project, hash="current") returns one row;
      // any all-projects fan-out maps each project scope to its row.
      return [rowFor(scope.scopeHash || "current")];
    },
    async search(scope) {
      return [{
        id: scope.scopeHash,
        memory: scope.scopeHash,
        similarity: 1,
        tags: [],
        containerTag: "tag",
        displayName: null,
        userName: null,
        userEmail: null,
        projectPath: null,
        projectName: null,
        gitRepoUrl: null,
        isPinned: false,
      }];
    },
    async insert() {},
    async delete() {},
    async getById() { return null; },
  };
  return {
    MemoryStore: class {},
    createMemoryStore: async () => fakeStore,
    getMemoryStore: async () => fakeStore,
    resetMemoryStore: async () => {},
  };
});

const { memoryClient } = await import(${JSON.stringify(clientUrl)});
${scriptBody}
`;
  writeFileSync(scriptPath, script, "utf-8");
  const result = Bun.spawnSync({
    cmd: [process.execPath, scriptPath],
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = Buffer.from(result.stdout).toString("utf8").trim();
  const stderr = Buffer.from(result.stderr).toString("utf8").trim();
  const jsonLine = stdout
    .split("\n")
    .reverse()
    .find((line) => line.trim().startsWith("{"));

  return {
    exitCode: result.exitCode,
    stdout,
    stderr,
    parsed: jsonLine ? JSON.parse(jsonLine) : null,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("memory scope", () => {
  it("defaults to project scope", () => {
    const result = runScenario(`
const res = await memoryClient.listMemories("current", 10);
console.log(JSON.stringify(res));
`);

    expect(result.exitCode).toBe(0);
    expect(result.parsed.success).toBe(true);
    expect(result.parsed.memories.length).toBe(1);
  });

  it("uses config defaultScope when provided", () => {
    const result = runScenario(`
const res = await memoryClient.searchMemories("hello", "current", "all-projects");
console.log(JSON.stringify(res));
`);

    expect(result.exitCode).toBe(0);
    expect(result.parsed.success).toBe(true);
    expect(result.parsed.results.length).toBe(2);
  });

  it("lets tool params override config", () => {
    const result = runScenario(`
const res = await memoryClient.listMemories("current", 10, "all-projects");
console.log(JSON.stringify(res));
`);

    expect(result.exitCode).toBe(0);
    expect(result.parsed.success).toBe(true);
    expect(result.parsed.memories.length).toBe(2);
  });

  it("queries across shards for all-projects", () => {
    const result = runScenario(`
const res = await memoryClient.searchMemories("hello", "current", "all-projects");
console.log(JSON.stringify({ ids: res.results.map((r) => r.id) }));
`);

    expect(result.exitCode).toBe(0);
    expect(result.parsed.ids).toEqual(["shard-a", "shard-b"]);
  });
});
