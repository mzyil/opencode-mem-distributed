import { describe, expect, it } from "bun:test";

describe("OpenCode plugin loader bundle boundary", () => {
  it("does not pull local embedding transformer internals into the plugin-loader bundle", async () => {
    const result = await Bun.build({
      entrypoints: ["./dist/plugin.js"],
      target: "bun",
      packages: "bundle",
    });

    expect(result.success).toBe(true);
    const output = await result.outputs[0]!.text();
    expect(output).not.toContain("node_modules/@xenova/transformers");
    expect(output).not.toContain("@xenova/transformers/src");
    expect(output).not.toContain("@xenova/transformers/dist");
    expect(output).not.toContain("node_modules/@huggingface/transformers");
    expect(output).not.toContain("@huggingface/transformers/dist");
  });
});
