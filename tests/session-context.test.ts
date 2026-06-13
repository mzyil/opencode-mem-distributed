// tests/session-context.test.ts
//
// Unit tests for SessionContextStore: directive parsing and session tracking.
// Pure logic — no I/O, no filesystem.

import { describe, it, expect } from "vitest";
import { SessionContextStore, parseMemScopeEnvelope } from "../src/services/session-context.js";

describe("SessionContextStore.parseAndStrip", () => {
  const store = new SessionContextStore();

  it("extracts defaults from a fenced directive", () => {
    const msg = `[opencode-mem]\n{"domain":"qna","default_write_scope":"qna:org","default_read_scopes":["qna:org"]}\n[/opencode-mem]\nrest of the prompt.`;
    const { stripped, defaults } = store.parseAndStrip(msg);
    expect(defaults?.domain).toBe("qna");
    expect(defaults?.default_write_scope).toBe("qna:org");
    expect(defaults?.default_read_scopes).toEqual(["qna:org"]);
    expect(stripped).toBe("rest of the prompt.");
  });

  it("returns null defaults when no directive is present", () => {
    const { stripped, defaults } = store.parseAndStrip("just a prompt");
    expect(defaults).toBeNull();
    expect(stripped).toBe("just a prompt");
  });

  it("ignores malformed JSON inside the directive and leaves message intact", () => {
    const msg = `[opencode-mem]\n{not valid json\n[/opencode-mem]\nbody`;
    const { stripped, defaults } = store.parseAndStrip(msg);
    expect(defaults).toBeNull();
    // When JSON is malformed the full message is returned unchanged
    expect(stripped).toBe(msg);
  });

  it("tolerates whitespace inside the fence", () => {
    const msg = `[opencode-mem]    \n  {"domain":"x","default_write_scope":"x:org","default_read_scopes":[]}  \n  [/opencode-mem]\nbody`;
    const { defaults } = store.parseAndStrip(msg);
    expect(defaults?.domain).toBe("x");
  });

  it("extracts peer_domains when present", () => {
    const msg = `[opencode-mem]\n{"domain":"qna","default_write_scope":"qna:user:U1","default_read_scopes":["qna:user:U1","qna:org"],"peer_domains":["code"]}\n[/opencode-mem]\nhello`;
    const { defaults } = store.parseAndStrip(msg);
    expect(defaults?.peer_domains).toEqual(["code"]);
  });

  it("handles empty body after stripping", () => {
    const msg = `[opencode-mem]\n{"domain":"x","default_write_scope":"x","default_read_scopes":[]}\n[/opencode-mem]\n`;
    const { stripped } = store.parseAndStrip(msg);
    expect(stripped.trim()).toBe("");
  });
});

describe("SessionContextStore register/get/forget/parsed-tracking", () => {
  it("tracks parsed sessions independently of registered defaults", () => {
    const store = new SessionContextStore();
    expect(store.hasParsed("s1")).toBe(false);
    store.markParsed("s1");
    expect(store.hasParsed("s1")).toBe(true);
    expect(store.get("s1")).toBeUndefined(); // marked parsed but no defaults registered
  });

  it("get returns registered defaults", () => {
    const store = new SessionContextStore();
    store.register("s2", {
      domain: "qna",
      default_write_scope: "qna:org",
      default_read_scopes: ["qna:org"],
    });
    const d = store.get("s2");
    expect(d?.domain).toBe("qna");
    expect(d?.default_write_scope).toBe("qna:org");
  });

  it("forget clears both parsed and defaults state", () => {
    const store = new SessionContextStore();
    store.register("s3", {
      domain: "x",
      default_write_scope: "x",
      default_read_scopes: [],
    });
    store.markParsed("s3");
    store.forget("s3");
    expect(store.hasParsed("s3")).toBe(false);
    expect(store.get("s3")).toBeUndefined();
  });

  it("second register for same session overwrites defaults", () => {
    const store = new SessionContextStore();
    store.register("s4", {
      domain: "a",
      default_write_scope: "a:org",
      default_read_scopes: ["a:org"],
    });
    store.register("s4", {
      domain: "b",
      default_write_scope: "b:org",
      default_read_scopes: ["b:org"],
    });
    expect(store.get("s4")?.domain).toBe("b");
  });

  it("get returns undefined for unknown session", () => {
    const store = new SessionContextStore();
    expect(store.get("unknown")).toBeUndefined();
  });

  it("hasParsed returns false after forget", () => {
    const store = new SessionContextStore();
    store.markParsed("s5");
    expect(store.hasParsed("s5")).toBe(true);
    store.forget("s5");
    expect(store.hasParsed("s5")).toBe(false);
  });
});

describe("parseMemScopeEnvelope", () => {
  it("extracts memScope from a JSON envelope", () => {
    const sys = JSON.stringify({
      slackContext: { channelId: "C", threadTs: "T", eventId: "E" },
      memScope: {
        domain: "qna",
        default_write_scope: "qna:channel:C",
        default_read_scopes: ["qna:org"],
      },
    });
    expect(parseMemScopeEnvelope(sys)).toEqual({
      domain: "qna",
      default_write_scope: "qna:channel:C",
      default_read_scopes: ["qna:org"],
    });
  });

  it("returns null when memScope is absent", () => {
    expect(parseMemScopeEnvelope(JSON.stringify({ slackContext: {} }))).toBeNull();
  });

  it("returns null on non-JSON input", () => {
    expect(parseMemScopeEnvelope("not json")).toBeNull();
  });

  it("returns null on undefined", () => {
    expect(parseMemScopeEnvelope(undefined)).toBeNull();
  });

  it("returns null on a malformed memScope (missing required fields)", () => {
    expect(parseMemScopeEnvelope(JSON.stringify({ memScope: { domain: "qna" } }))).toBeNull();
  });
});
