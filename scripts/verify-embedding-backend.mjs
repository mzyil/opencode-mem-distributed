#!/usr/bin/env node
/**
 * Embedding-backend smoke test — verifies the local @huggingface/transformers
 * feature-extraction path loads and runs the native ONNX runtime without
 * crashing on the host platform.
 *
 * This is the reproducible form of the manual checks requested when migrating
 * off @xenova/transformers: the prior revert (8fb0836) was motivated by native
 * ONNX runtime crashes under Windows + Bun, so this runs in CI across
 * ubuntu / macOS / windows to catch a regression before merge.
 *
 * Uses a tiny model (all-MiniLM-L6-v2, ~25 MB) — the goal is to exercise the
 * runtime load + a real embedding call, not to validate any specific model.
 *
 * Run with either `bun scripts/verify-embedding-backend.mjs` or
 * `node scripts/verify-embedding-backend.mjs`.
 */

const MODEL = "Xenova/all-MiniLM-L6-v2";
const EXPECTED_DIMS = 384;

const runtime = typeof globalThis.Bun !== "undefined" ? "bun" : "node";
console.log(
  `[verify-embedding] runtime=${runtime} platform=${process.platform} arch=${process.arch}`
);

const { pipeline, env } = await import("@huggingface/transformers");

// Mirror the plugin's runtime configuration.
env.allowLocalModels = true;
env.allowRemoteModels = true;
try {
  env.backends.onnx.wasm.numThreads = 1;
} catch {
  /* not fatal — only relevant for the wasm backend */
}

console.log(`[verify-embedding] loading feature-extraction pipeline for ${MODEL} ...`);
const extractor = await pipeline("feature-extraction", MODEL);

const samples = [
  "Hello world, this is a test.",
  "Hallo Welt, dies ist ein Test.", // non-English: exercises the multilingual tokenizer path
];

for (const text of samples) {
  const out = await extractor(text, { pooling: "mean", normalize: true });
  const dims = out.dims?.[out.dims.length - 1];
  if (dims !== EXPECTED_DIMS) {
    console.error(`[verify-embedding] FAIL: expected ${EXPECTED_DIMS} dims, got ${dims}`);
    process.exit(1);
  }
  const vec = Array.from(out.data);
  const allFinite = vec.every((x) => Number.isFinite(x));
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
  if (!allFinite || !(norm > 0.9 && norm < 1.1)) {
    console.error(
      `[verify-embedding] FAIL: bad vector (finite=${allFinite}, norm=${norm.toFixed(4)})`
    );
    process.exit(1);
  }
  console.log(
    `[verify-embedding] ok: "${text.slice(0, 24)}..." -> ${dims} dims, L2=${norm.toFixed(4)}`
  );
}

console.log("[verify-embedding] PASS — ONNX runtime loaded and embeddings produced.");
