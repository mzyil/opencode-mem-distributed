/**
 * SDK-based structured output via opencode v2 session.prompt.
 *
 * Replaces the old auth.json/OAuth-juggling flow. Instead of forging requests
 * to provider HTTP endpoints ourselves, we delegate to the running opencode
 * server: it already owns the user's auth (any provider, including
 * github-copilot personal/business), token refresh, and provider routing.
 *
 * Per call we create a transient session, prompt with a JSON schema, then
 * delete the session so it does not pollute the user's TUI session list.
 */

import type { z } from "zod";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client";

let _connectedProviders: Set<string> = new Set();
let _v2Client: OpencodeClient | undefined;

export function setConnectedProviders(providers: string[]): void {
  _connectedProviders = new Set(providers);
}

export function isProviderConnected(providerName: string): boolean {
  return _connectedProviders.has(providerName);
}

export function setV2Client(client: OpencodeClient): void {
  _v2Client = client;
}

export function getV2Client(): OpencodeClient | undefined {
  return _v2Client;
}

export function createV2Client(serverUrl: URL | string): OpencodeClient {
  const baseUrl = typeof serverUrl === "string" ? serverUrl : serverUrl.toString();
  return createOpencodeClient({ baseUrl });
}

export interface StructuredOutputOptions<T> {
  client: OpencodeClient;
  providerID: string;
  modelID: string;
  systemPrompt: string;
  userPrompt: string;
  schema: z.ZodType<T>;
  directory?: string;
  retryCount?: number;
  /**
   * Agent to run the structured-output prompt under. Must be passed
   * explicitly: with no agent, opencode resolves the server's *default*
   * primary agent, which under oh-my-opencode is named with a leading
   * zero-width space (e.g. "​Sisyphus - Ultraworker"). The default-agent
   * lookup uses the clean name and fails ("default agent ... not found"),
   * surfacing as a 500 / missing-`info` error here. Defaults to "general"
   * (a native opencode agent that is always present).
   */
  agent?: string;
  /**
   * Max attempts for the prompt call. Bedrock latency for some models is
   * spiky (occasional >45s responses / throttles), and capture runs on a
   * bounded idle window — a single slow call would silently drop the memory.
   * Each attempt uses a fresh transient session and is bounded by
   * `attemptTimeoutMs`; transient failures are retried with linear backoff.
   * Default 3.
   */
  maxAttempts?: number;
  /** Per-attempt timeout in ms guarding against latency spikes. Default 30000. */
  attemptTimeoutMs?: number;
}

/** Native opencode agent; always registered, no oh-my-opencode dependency. */
const DEFAULT_CAPTURE_AGENT = "general";
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 30_000;

/** Reject if `p` does not settle within `ms`; the underlying call is abandoned. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`opencode-mem: ${label} timed out after ${ms}ms`)),
      ms
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/**
 * Generate one structured-output completion via opencode's v2 API.
 *
 * Retries up to `maxAttempts` times (fresh transient session each attempt,
 * bounded by `attemptTimeoutMs`) to absorb Bedrock latency spikes / throttles.
 * Throws the last error if every attempt fails: prompt failure / timeout,
 * AssistantMessage.error (StructuredOutputError / ApiError / ...), missing
 * `info.structured`, or Zod validation failure.
 */
export async function generateStructuredOutput<T>(opts: StructuredOutputOptions<T>): Promise<T> {
  const {
    client,
    providerID,
    modelID,
    systemPrompt,
    userPrompt,
    schema,
    directory,
    retryCount,
    agent = DEFAULT_CAPTURE_AGENT,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    attemptTimeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS,
  } = opts;

  // zod v4 exposes JSON Schema export natively (instance `.toJSONSchema()`
  // and global `z.toJSONSchema()`); we prefer instance, fall back to global.
  // This avoids pulling in a separate `zod-to-json-schema` dependency.
  const jsonSchema =
    (
      schema as unknown as {
        toJSONSchema?: () => Record<string, unknown>;
      }
    ).toJSONSchema?.() ?? (await import("zod")).z.toJSONSchema(schema);

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const created = await client.session.create({
      title: "opencode-mem capture",
      ...(directory ? { directory } : {}),
    });
    const sessionID = (created as { data?: { id?: string } })?.data?.id;
    if (!sessionID) {
      lastError = new Error(
        "opencode-mem: session.create returned no session id; cannot generate structured output"
      );
      continue;
    }

    try {
      const promptResult = await withTimeout(
        client.session.prompt({
          sessionID,
          ...(directory ? { directory } : {}),
          agent,
          model: { providerID, modelID },
          system: systemPrompt,
          parts: [{ type: "text", text: userPrompt }],
          format: {
            type: "json_schema",
            schema: jsonSchema as Record<string, unknown>,
            ...(retryCount !== undefined ? { retryCount } : {}),
          },
          // Must be false: with noReply=true, opencode records the user message
          // but does not run the assistant, so the StructuredOutput tool never
          // fires and `info.structured` is never populated. The transient session
          // is deleted in `finally`, so the generated reply is never user-visible.
          noReply: false,
        }),
        attemptTimeoutMs,
        `session.prompt (attempt ${attempt}/${maxAttempts}, model ${modelID})`
      );

      const result = promptResult as {
        data?: {
          info?: {
            structured?: unknown;
            error?: { name: string; data?: { message?: string } };
          };
        };
        error?: unknown;
      };
      const info = result.data?.info;
      if (!info) {
        // Surface the SDK-level error the call returned instead of swallowing
        // it behind a generic message — this is usually the real cause.
        const detail = result.error ? `: ${JSON.stringify(result.error)}` : "";
        throw new Error(`opencode-mem: prompt response missing \`info\`${detail}`);
      }

      if (info.error) {
        const msg = info.error.data?.message ?? info.error.name;
        throw new Error(`opencode-mem: opencode reported ${info.error.name}: ${msg}`);
      }

      if (info.structured === undefined || info.structured === null) {
        throw new Error(
          "opencode-mem: opencode returned no structured output (info.structured was empty)"
        );
      }

      return schema.parse(info.structured);
    } catch (error) {
      lastError = error;
      // Linear backoff before the next attempt; capture is best-effort, so we
      // retry every failure (timeout, throttle, transient 5xx, or a one-off
      // invalid/empty structured result) rather than classifying error types.
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    } finally {
      // Best-effort cleanup: a leftover transient session is cosmetic and must
      // not fail (or block a retry of) the capture.
      try {
        await client.session.delete({
          sessionID,
          ...(directory ? { directory } : {}),
        });
      } catch {
        // intentionally swallowed
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`opencode-mem: structured output failed after ${maxAttempts} attempts`);
}
