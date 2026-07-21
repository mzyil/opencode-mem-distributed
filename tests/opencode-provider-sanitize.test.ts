import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  sanitizeJsonSchemaForGrammar,
  generateStructuredOutput,
} from "../src/services/ai/opencode-provider.js";

describe("sanitizeJsonSchemaForGrammar", () => {
  it("recursively strips grammar-incompatible keys while preserving structure", () => {
    const input = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        summary: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        nested: {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
          additionalProperties: false,
          propertyNames: { pattern: "^x" },
        },
      },
      required: ["summary", "tags"],
      additionalProperties: false,
    };

    const out = sanitizeJsonSchemaForGrammar(input);

    // The keys Bedrock grammar decoders (MiniMax/GLM) reject are gone everywhere.
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("additionalProperties");
    expect(serialized).not.toContain("$schema");
    expect(serialized).not.toContain("propertyNames");

    // The meaningful shape survives.
    expect(out).toEqual({
      type: "object",
      properties: {
        summary: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        nested: { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
      },
      required: ["summary", "tags"],
    });

    // The input is not mutated.
    expect(input.additionalProperties).toBe(false);
    expect((input.properties.nested as { propertyNames?: unknown }).propertyNames).toBeDefined();
  });
});

describe("generateStructuredOutput proactive sanitization", () => {
  const captureSchema = z.object({
    summary: z.string(),
    type: z.string(),
    tags: z.array(z.string()),
  });

  it("sends an already-sanitized schema on attempt #1 — no wasted grammar-failure round-trip", async () => {
    const promptCalls: Array<{ schema: unknown }> = [];
    // Fake opencode client modelling a grammar-decoder provider (MiniMax/GLM):
    // it REJECTS any schema still carrying `additionalProperties`/`propertyNames`.
    // With proactive sanitization the very first prompt already omits them, so
    // this provider must succeed on the first call with no thrown-away attempt.
    const fakeClient = {
      session: {
        create: async () => ({ data: { id: "ses_grammar_test" } }),
        prompt: async (args: { format: { schema: unknown } }) => {
          promptCalls.push({ schema: args.format.schema });
          const stillStrict = JSON.stringify(args.format.schema).includes("additionalProperties");
          if (stillStrict) {
            return {
              data: {
                info: {
                  error: {
                    name: "StructuredOutputError",
                    data: { message: 'Grammar error: Unimplemented keys: ["propertyNames"]' },
                  },
                },
              },
            };
          }
          return { data: { info: { structured: { summary: "s", type: "feature", tags: ["a"] } } } };
        },
        delete: async () => ({}),
      },
    };

    const result = await generateStructuredOutput({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: fakeClient as any,
      providerID: "amazon-bedrock",
      modelID: "minimax.minimax-m2.5",
      systemPrompt: "sys",
      userPrompt: "usr",
      schema: captureSchema,
    });

    expect(result).toEqual({ summary: "s", type: "feature", tags: ["a"] });
    // Exactly one call: no failed strict attempt to recover from.
    expect(promptCalls).toHaveLength(1);
    // The first (and only) schema sent is already the lowest-common-denominator shape.
    const firstSchema = JSON.stringify(promptCalls[0].schema);
    expect(firstSchema).not.toContain("additionalProperties");
    expect(firstSchema).not.toContain("propertyNames");
    expect(firstSchema).not.toContain("$schema");
  });

  it("still succeeds in a single call on an Anthropic-style decoder (no behaviour regression)", async () => {
    const promptCalls: Array<{ schema: unknown }> = [];
    // A permissive decoder that accepts any schema shape. Proactive sanitization
    // must not change the happy path here: one call, valid Zod-parsed output.
    const fakeClient = {
      session: {
        create: async () => ({ data: { id: "ses_anthropic_test" } }),
        prompt: async (args: { format: { schema: unknown } }) => {
          promptCalls.push({ schema: args.format.schema });
          return { data: { info: { structured: { summary: "s", type: "feature", tags: ["a"] } } } };
        },
        delete: async () => ({}),
      },
    };

    const result = await generateStructuredOutput({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: fakeClient as any,
      providerID: "amazon-bedrock",
      modelID: "eu.anthropic.claude-sonnet-4-6",
      systemPrompt: "sys",
      userPrompt: "usr",
      schema: captureSchema,
    });

    expect(result).toEqual({ summary: "s", type: "feature", tags: ["a"] });
    expect(promptCalls).toHaveLength(1);
  });
});
