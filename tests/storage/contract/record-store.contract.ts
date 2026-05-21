import { expect, test } from "bun:test";
import type { RecordStore } from "../../../src/services/storage/types.ts";

export interface ContractFixture {
  name: string;
  create(): Promise<RecordStore>;
  teardown(): Promise<void>;
}

export function runRecordStoreContract(fixture: ContractFixture) {
  const N = fixture.name;
  let store: RecordStore;

  const scope = { scope: "user" as const, scopeHash: "h1" };
  const baseRow = (id: string, overrides: Partial<any> = {}) => ({
    id,
    content: `content-${id}`,
    containerTag: "opencode-user",
    tags: ["alpha", "beta"],
    type: null,
    createdAt: 1000 + Number(id.replace(/\D/g, "")) || 1000,
    updatedAt: 1000,
    metadata: { sessionID: `sess-${id}` },
    displayName: null,
    userName: null,
    userEmail: null,
    projectPath: null,
    projectName: null,
    gitRepoUrl: null,
    isPinned: false,
    vector: new Float32Array([1, 0, 0, 0]),
    tagsVector: new Float32Array([0, 1, 0, 0]),
    ...overrides,
  });

  test(`[${N}] init + insert + getById round-trips`, async () => {
    store = await fixture.create();
    await store.insert(scope, baseRow("m1"));
    const got = await store.getById(scope, "m1");
    expect(got).not.toBeNull();
    expect(got!.content).toBe("content-m1");
    expect(Array.from(got!.vector)).toEqual([1, 0, 0, 0]);
    expect(Array.from(got!.tagsVector!)).toEqual([0, 1, 0, 0]);
    expect(got!.tags).toEqual(["alpha", "beta"]);
    expect(got!.metadata).toEqual({ sessionID: "sess-m1" });
    await store.close();
    await fixture.teardown();
  });

  test(`[${N}] list filters by containerTag and session`, async () => {
    store = await fixture.create();
    await store.insert(scope, baseRow("m1", { containerTag: "ct-a" }));
    await store.insert(scope, baseRow("m2", { containerTag: "ct-b" }));
    await store.insert(
      scope,
      baseRow("m3", { containerTag: "ct-a", metadata: { sessionID: "X" } })
    );

    expect((await store.list(scope, { containerTag: "ct-a" })).length).toBe(2);
    expect((await store.list(scope, { containerTag: "" })).length).toBe(3);
    const bySession = await store.list(scope, { sessionId: "X" });
    expect(bySession.length).toBe(1);
    expect(bySession[0].id).toBe("m3");
    await store.close();
    await fixture.teardown();
  });

  test(`[${N}] update applies a partial patch`, async () => {
    store = await fixture.create();
    await store.insert(scope, baseRow("m1"));
    await store.update(scope, "m1", { content: "new!", isPinned: true });
    const got = await store.getById(scope, "m1");
    expect(got!.content).toBe("new!");
    expect(got!.isPinned).toBe(true);
    expect(Array.from(got!.vector)).toEqual([1, 0, 0, 0]);
    await store.close();
    await fixture.teardown();
  });

  test(`[${N}] delete removes the row`, async () => {
    store = await fixture.create();
    await store.insert(scope, baseRow("m1"));
    await store.delete(scope, "m1");
    expect(await store.getById(scope, "m1")).toBeNull();
    await store.close();
    await fixture.teardown();
  });

  test(`[${N}] countByContainer + countAll`, async () => {
    store = await fixture.create();
    await store.insert(scope, baseRow("m1", { containerTag: "a" }));
    await store.insert(scope, baseRow("m2", { containerTag: "a" }));
    await store.insert(scope, baseRow("m3", { containerTag: "b" }));
    expect(await store.countByContainer(scope, "a")).toBe(2);
    expect(await store.countAll(scope)).toBe(3);
    await store.close();
    await fixture.teardown();
  });

  test(`[${N}] iterateVectors streams content + tags`, async () => {
    store = await fixture.create();
    for (const id of ["a", "b", "c"]) {
      await store.insert(
        scope,
        baseRow(id, { tagsVector: id === "c" ? null : new Float32Array([0, 1, 0, 0]) })
      );
    }
    const content: string[] = [];
    for await (const r of store.iterateVectors(scope, "content")) content.push(r.id);
    expect(content.sort()).toEqual(["a", "b", "c"]);
    const tags: string[] = [];
    for await (const r of store.iterateVectors(scope, "tags")) tags.push(r.id);
    expect(tags.sort()).toEqual(["a", "b"]);
    await store.close();
    await fixture.teardown();
  });

  test(`[${N}] setPinned + listScopes`, async () => {
    store = await fixture.create();
    await store.insert(scope, baseRow("m1"));
    await store.setPinned(scope, "m1", true);
    expect((await store.getById(scope, "m1"))!.isPinned).toBe(true);

    const scope2 = { scope: "user" as const, scopeHash: "h2" };
    await store.insert(scope2, baseRow("m2"));
    const scopes = (await store.listScopes("user")).map((s) => s.scopeHash).sort();
    expect(scopes).toEqual(["h1", "h2"]);
    await store.close();
    await fixture.teardown();
  });

  test(`[${N}] distinctTags returns one row per containerTag`, async () => {
    store = await fixture.create();
    await store.insert(scope, baseRow("m1", { containerTag: "a" }));
    await store.insert(scope, baseRow("m2", { containerTag: "a" }));
    await store.insert(scope, baseRow("m3", { containerTag: "b" }));
    const tags = await store.distinctTags(scope);
    const cts = tags.map((t) => t.containerTag).sort();
    expect(cts).toEqual(["a", "b"]);
    await store.close();
    await fixture.teardown();
  });

  test(`[${N}] getByIds with containerTag filter`, async () => {
    store = await fixture.create();
    await store.insert(scope, baseRow("m1", { containerTag: "a" }));
    await store.insert(scope, baseRow("m2", { containerTag: "b" }));
    const aOnly = await store.getByIds(scope, ["m1", "m2"], "a");
    expect(aOnly.length).toBe(1);
    expect(aOnly[0].id).toBe("m1");
    const both = await store.getByIds(scope, ["m1", "m2"], "");
    expect(both.length).toBe(2);
    await store.close();
    await fixture.teardown();
  });
}
