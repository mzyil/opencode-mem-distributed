import { log } from "./logger.js";

export interface ScopeDefaults {
  domain: string;
  default_write_scope: string;
  default_read_scopes: string[];
  peer_domains?: string[];
}

// Sentinel block format prepended by session-manager-v2:
//   [opencode-mem]
//   { "domain": "qna", "default_write_scope": "qna:channel:C123", ... }
//   [/opencode-mem]
const DIRECTIVE_RE = /\[opencode-mem\]\s*([\s\S]*?)\s*\[\/opencode-mem\]/;

// Maximum number of sessions tracked simultaneously (FIFO eviction when exceeded).
// There is no onSessionEnd hook in the current plugin API, so we rely on this
// bound to cap memory growth.
const MAX_SESSIONS = 10_000;

export class SessionContextStore {
  private readonly defaults = new Map<string, ScopeDefaults>();
  // Tracks sessions for which a parse attempt has been made (even if no directive was found).
  private readonly parsed = new Set<string>();
  // Insertion-order queue used for FIFO eviction when we exceed MAX_SESSIONS.
  private readonly insertionOrder: string[] = [];

  parseAndStrip(systemMessage: string): { stripped: string; defaults: ScopeDefaults | null } {
    const match = DIRECTIVE_RE.exec(systemMessage);
    if (!match || match[1] === undefined) return { stripped: systemMessage, defaults: null };
    try {
      const parsed = JSON.parse(match[1]) as ScopeDefaults;
      const stripped = systemMessage.replace(DIRECTIVE_RE, "").trimStart();
      return { stripped, defaults: parsed };
    } catch (err) {
      // Malformed directive: log and pass the message through unchanged.
      // We deliberately do NOT throw — a bad directive must not break the chat.
      log("[opencode-mem] failed to parse [opencode-mem] directive", {
        error: err instanceof Error ? err.message : String(err),
      });
      return { stripped: systemMessage, defaults: null };
    }
  }

  register(sessionId: string, defaults: ScopeDefaults): void {
    if (!this.defaults.has(sessionId)) {
      // Evict oldest entry when at capacity.
      if (this.insertionOrder.length >= MAX_SESSIONS) {
        const oldest = this.insertionOrder.shift()!;
        this.defaults.delete(oldest);
        this.parsed.delete(oldest);
      }
      this.insertionOrder.push(sessionId);
    }
    this.defaults.set(sessionId, defaults);
  }

  get(sessionId: string): ScopeDefaults | undefined {
    return this.defaults.get(sessionId);
  }

  /** Mark that a parse attempt has been made for this session (regardless of result). */
  markParsed(sessionId: string): void {
    this.parsed.add(sessionId);
  }

  /** Returns true if a parse attempt has already been made for this session. */
  hasParsed(sessionId: string): boolean {
    return this.parsed.has(sessionId);
  }

  forget(sessionId: string): void {
    this.defaults.delete(sessionId);
    this.parsed.delete(sessionId);
    const idx = this.insertionOrder.indexOf(sessionId);
    if (idx !== -1) this.insertionOrder.splice(idx, 1);
  }
}

// Singleton — the plugin registers a single instance and the tool reads from it.
export const sessionContextStore = new SessionContextStore();
