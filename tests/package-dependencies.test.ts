import { describe, expect, it } from "bun:test";
import pkg from "../package.json";

describe("published dependency constraints", () => {
  it("uses Xenova transformers as the stable local embedding backend", () => {
    expect(pkg.dependencies["@xenova/transformers"]).toBe("^2.17.2");
    expect(pkg.dependencies).not.toHaveProperty("@huggingface/transformers");
  });
});
