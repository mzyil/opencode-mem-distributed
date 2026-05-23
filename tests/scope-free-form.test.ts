// tests/scope-free-form.test.ts
//
// Unit tests for free-form scope strings via the MemoryStore + ExactScanBackend
// stack.  No bun:sqlite dependency — we supply a minimal in-memory RecordStore
// so these run under vitest/Node without a Bun runtime.

import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { MemoryStore } from "../src/services/storage/memory-store.js";
import { ExactScanBackend } from "../src/services/vector-backends/exact-scan-backend.js";
import type {
  ListOptions,
  MemoryRow,
  RecordStore,
  ScopeKey,
  TagsRow,
} from "../src/services/storage/types.js";

// ---------------------------------------------------------------------------
// Minimal in-memory RecordStore — no filesystem, no bun:sqlite.
// Stores rows in a plain Map keyed by id. Scope filtering happens at read
// time by collecting all rows that were inserted with a matching scope.
// ---------------------------------------------------------------------------

class InMemoryRecordStore implements RecordStore {
  // { id -> { row, scope } }
  private readonly rows = new Map<string, { row: MemoryRow; scope: string }>();

  async init(): Promise<void> {}
  async close(): Promise<void> {}

  async insert(scopeKey: ScopeKey, row: MemoryRow): Promise<void> {
    this.rows.set(row.id, { row, scope: scopeKey.scope });
  }

  async update(scopeKey: ScopeKey, id: string, patch: Partial<MemoryRow>): Promise<void> {
    const entry = this.rows.get(id);
    if (!entry) return;
    this.rows.set(id, { row: { ...entry.row, ...patch }, scope: scopeKey.scope });
  }

  async delete(_scopeKey: ScopeKey, id: string): Promise<void> {
    this.rows.delete(id);
  }

  async getById(_scopeKey: ScopeKey, id: string): Promise<MemoryRow | null> {
    return this.rows.get(id)?.row ?? null;
  }

  async list(scopes: string[], opts: ListOptions): Promise<MemoryRow[]> {
    if (!scopes || scopes.length === 0) return [];
    const scopeSet = new Set(scopes);
    const results: MemoryRow[] = [];
    for (const { row, scope } of this.rows.values()) {
      if (!scopeSet.has(scope)) continue;
      if (opts.containerTag && opts.containerTag !== "" && row.containerTag !== opts.containerTag)
        continue;
      results.push(row);
    }
    results.sort((a, b) => b.createdAt - a.createdAt);
    const limit = opts.limit ?? 10_000;
    return results.slice(0, limit);
  }

  async countByContainer(scopes: string[], containerTag: string): Promise<number> {
    if (!scopes || scopes.length === 0) return 0;
    const scopeSet = new Set(scopes);
    let n = 0;
    for (const { row, scope } of this.rows.values()) {
      if (scopeSet.has(scope) && row.containerTag === containerTag) n++;
    }
    return n;
  }

  async countAll(scopes: string[]): Promise<number> {
    if (!scopes || scopes.length === 0) return 0;
    const scopeSet = new Set(scopes);
    let n = 0;
    for (const { scope } of this.rows.values()) {
      if (scopeSet.has(scope)) n++;
    }
    return n;
  }

  async distinctTags(scopes: string[]): Promise<TagsRow[]> {
    if (!scopes || scopes.length === 0) return [];
    const scopeSet = new Set(scopes);
    const seen = new Set<string>();
    const out: TagsRow[] = [];
    for (const { row, scope } of this.rows.values()) {
      if (!scopeSet.has(scope)) continue;
      const key = row.containerTag;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        containerTag: row.containerTag,
        displayName: row.displayName,
        userName: row.userName,
        userEmail: row.userEmail,
        projectPath: row.projectPath,
        projectName: row.projectName,
        gitRepoUrl: row.gitRepoUrl,
      });
    }
    return out;
  }

  async getByIds(scopes: string[], ids: string[], containerTag: string): Promise<MemoryRow[]> {
    if (ids.length === 0 || !scopes || scopes.length === 0) return [];
    const scopeSet = new Set(scopes);
    const idSet = new Set(ids);
    const out: MemoryRow[] = [];
    for (const { row, scope } of this.rows.values()) {
      if (!scopeSet.has(scope) || !idSet.has(row.id)) continue;
      if (containerTag !== "" && row.containerTag !== containerTag) continue;
      out.push(row);
    }
    return out;
  }

  async lookupScopeKeys(scopes: string[]): Promise<ScopeKey[]> {
    const seen = new Set<string>();
    const out: ScopeKey[] = [];
    for (const scope of scopes) {
      if (seen.has(scope)) continue;
      seen.add(scope);
      out.push({ scope, scopeHash: "" });
    }
    return out;
  }

  async setPinned(scopeKey: ScopeKey, id: string, pinned: boolean): Promise<void> {
    const entry = this.rows.get(id);
    if (entry)
      this.rows.set(id, { row: { ...entry.row, isPinned: pinned }, scope: scopeKey.scope });
  }

  async listScopes(_kind: "user" | "project"): Promise<ScopeKey[]> {
    return [];
  }

  iterateVectors(
    scopeKey: ScopeKey,
    kind: "content" | "tags"
  ): AsyncIterable<{ id: string; vector: Float32Array }> {
    const entries = Array.from(this.rows.values()).filter((e) => e.scope === scopeKey.scope);
    return (async function* () {
      for (const { row } of entries) {
        const v = kind === "tags" ? row.tagsVector : row.vector;
        if (v && v.length > 0) yield { id: row.id, vector: v };
      }
    })();
  }
}

// ---------------------------------------------------------------------------
// Helper: build a minimal MemoryRow for a given scope+content combination.
// ---------------------------------------------------------------------------

function makeRow(
  scope: string,
  content: string,
  overrides: Partial<MemoryRow> = {}
): { scopeKey: ScopeKey; row: MemoryRow } {
  return {
    scopeKey: { scope, scopeHash: "" },
    row: {
      id: randomUUID(),
      content,
      containerTag: "test",
      tags: null,
      type: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
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
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("scope as free-form string", () => {
  let recordStore: InMemoryRecordStore;
  let store: MemoryStore;

  beforeEach(() => {
    recordStore = new InMemoryRecordStore();
    store = new MemoryStore(recordStore, new ExactScanBackend());
  });

  it("accepts arbitrary string scopes on write", async () => {
    const { scopeKey: sk1, row: r1 } = makeRow("qna:user:U1", "hello");
    const { scopeKey: sk2, row: r2 } = makeRow("code:org", "world");
    await store.insert(sk1, r1);
    await store.insert(sk2, r2);

    const rows = await store.list(["qna:user:U1"], {});
    expect(rows.map((m) => m.content)).toEqual(["hello"]);
  });

  it("preserves back-compat for the legacy 'project' scope", async () => {
    const { scopeKey, row } = makeRow("project", "legacy row");
    await store.insert(scopeKey, row);

    const rows = await store.list(["project"], {});
    expect(rows[0]?.content).toBe("legacy row");
  });

  it("preserves back-compat for the legacy 'all-projects' scope", async () => {
    const { scopeKey, row } = makeRow("all-projects", "legacy global");
    await store.insert(scopeKey, row);

    const rows = await store.list(["all-projects"], {});
    expect(rows[0]?.content).toBe("legacy global");
  });

  it("returns rows across multiple scopes on read", async () => {
    const pairs = [
      makeRow("qna:user:U1", "a"),
      makeRow("qna:channel:C1", "b"),
      makeRow("qna:org", "c"),
      makeRow("code:user:U1", "d"),
    ];
    for (const { scopeKey, row } of pairs) {
      await store.insert(scopeKey, row);
    }

    const rows = await store.list(["qna:user:U1", "qna:channel:C1", "qna:org"], {});
    expect(rows.map((r) => r.content).sort()).toEqual(["a", "b", "c"]);
  });

  it("returns empty for empty scopes array (defensive default)", async () => {
    const { scopeKey, row } = makeRow("qna:user:U1", "hello");
    await store.insert(scopeKey, row);

    const rows = await store.list([], {});
    expect(rows).toEqual([]);
  });

  it("does not bleed rows across sibling scopes", async () => {
    const { scopeKey: sk1, row: r1 } = makeRow("qna:user:U1", "only-u1");
    const { scopeKey: sk2, row: r2 } = makeRow("qna:user:U2", "only-u2");
    await store.insert(sk1, r1);
    await store.insert(sk2, r2);

    const u1Rows = await store.list(["qna:user:U1"], {});
    expect(u1Rows.map((r) => r.content)).toEqual(["only-u1"]);

    const u2Rows = await store.list(["qna:user:U2"], {});
    expect(u2Rows.map((r) => r.content)).toEqual(["only-u2"]);
  });

  it("scopes with colons are treated as opaque labels, not prefixes", async () => {
    // "qna:user" and "qna:user:U1" are distinct scopes — a query for
    // "qna:user" must NOT return rows stored under "qna:user:U1".
    const { scopeKey: sk1, row: r1 } = makeRow("qna:user", "parent-scope");
    const { scopeKey: sk2, row: r2 } = makeRow("qna:user:U1", "child-scope");
    await store.insert(sk1, r1);
    await store.insert(sk2, r2);

    const parentOnly = await store.list(["qna:user"], {});
    expect(parentOnly.map((r) => r.content)).toEqual(["parent-scope"]);
  });
});
