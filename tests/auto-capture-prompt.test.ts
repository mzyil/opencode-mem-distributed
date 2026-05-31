import { describe, it, expect } from "bun:test";
import { buildCaptureSystemPrompt } from "../src/services/auto-capture.js";

describe("buildCaptureSystemPrompt", () => {
  it("uses the configured instructions verbatim when set, plus the language line", () => {
    const out = buildCaptureSystemPrompt("English", "CUSTOM QNA POLICY: capture facts.");
    expect(out).toContain("CUSTOM QNA POLICY: capture facts.");
    expect(out).toContain("English");
    expect(out).not.toContain("software development project");
  });

  it("falls back to the default software-dev recorder when instructions are unset", () => {
    const out = buildCaptureSystemPrompt("German", undefined);
    expect(out).toContain("software development project");
    expect(out).toContain("German");
  });
});
