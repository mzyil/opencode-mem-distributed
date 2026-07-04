// tests/format-error.test.ts
import { describe, expect, test } from "bun:test";
import { formatError } from "../src/services/logger.ts";

describe("formatError", () => {
  test("renders a plain Error's name and message", () => {
    expect(formatError(new Error("boom"))).toBe("Error: boom");
  });

  test("walks the .cause chain so a wrapped error surfaces the ROOT cause", () => {
    // The exact masking incident: a connect failure wrapped by 'Migration failed'.
    const root = new Error("getaddrinfo ENOTFOUND some-aurora.rds.amazonaws.com");
    const wrapped = new Error("Migration failed at migration setup", { cause: root });
    const out = formatError(wrapped);
    expect(out).toContain("Migration failed at migration setup");
    expect(out).toContain("getaddrinfo ENOTFOUND some-aurora.rds.amazonaws.com");
  });

  test("does not collapse a real cause to <unknown>", () => {
    const wrapped = new Error("Migration failed", { cause: new Error("connection refused") });
    expect(formatError(wrapped)).not.toContain("<unknown>");
  });

  test("handles a string thrown value", () => {
    expect(formatError("just a string")).toBe("just a string");
  });

  test("handles a non-Error object", () => {
    expect(formatError({ code: "ECONNREFUSED" })).toBe('{"code":"ECONNREFUSED"}');
  });

  test("terminates on a self-referential cause cycle", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b", { cause: a }) as Error & { cause?: unknown };
    a.cause = b; // cycle
    const out = formatError(b);
    expect(out).toContain("Error: b");
    expect(out).toContain("Error: a");
  });
});
