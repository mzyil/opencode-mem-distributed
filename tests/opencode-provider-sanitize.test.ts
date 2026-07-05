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

describe("generateStructuredOutput grammar recovery", () => {
  it("retries with a sanitized schema after a grammar-shape error, then succeeds", async () => {
    const promptCalls: Array<{ schema: unknown }> = [];
    // Fake opencode client: a grammar-decoder provider (MiniMax/GLM) that rejects
    // any schema carrying `additionalProperties`, and only produces structured
    // output once it receives the sanitized shape.
    const fakeClient = {
      session: {
        create: async () => ({ data: { id: "ses_grammar_test" } }),
        prompt: async (args: { format: { schema: unknown } }) => {
          promptCalls.push({ schema: args.format.schema });
          const isStrict = JSON.stringify(args.format.schema).includes("additionalProperties");
          if (isStrict) {
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

    const schema = z.object({
      summary: z.string(),
      type: z.string(),
      tags: z.array(z.string()),
    });

    const result = await generateStructuredOutput({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: fakeClient as any,
      providerID: "amazon-bedrock",
      modelID: "minimax.minimax-m2.5",
      systemPrompt: "sys",
      userPrompt: "usr",
      schema,
    });

    expect(result).toEqual({ summary: "s", type: "feature", tags: ["a"] });
    expect(promptCalls).toHaveLength(2);
    // First attempt sent the strict schema; the recovery re-sent the sanitized one.
    expect(JSON.stringify(promptCalls[0].schema)).toContain("additionalProperties");
    expect(JSON.stringify(promptCalls[1].schema)).not.toContain("additionalProperties");
  });
});
