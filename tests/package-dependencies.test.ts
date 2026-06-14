import { describe, expect, it } from "bun:test";
import pkg from "../package.json";

describe("published dependency constraints", () => {
  it("uses @huggingface/transformers (v4+) as the local embedding backend", () => {
    // Migrated from @xenova/transformers@^2.17.2 (frozen, sharp@^0.32 postinstall)
    // to @huggingface/transformers@^4 (active successor, sharp@^0.34 prebuilt @img,
    // installs cleanly under script-skipping plugin installers). The earlier revert
    // (8fb0836) was specific to the v4.0.1 native-ONNX runtime on Windows, not a
    // permanent rejection — see PR for the platform verification matrix.
    expect(pkg.dependencies["@huggingface/transformers"]).toMatch(/^\^?4\./);
    expect(pkg.dependencies).not.toHaveProperty("@xenova/transformers");
  });
});
