# OpenCode Memory

[![npm version](https://img.shields.io/npm/v/opencode-mem.svg)](https://www.npmjs.com/package/opencode-mem)
[![npm downloads](https://img.shields.io/npm/dm/opencode-mem.svg)](https://www.npmjs.com/package/opencode-mem)
[![license](https://img.shields.io/npm/l/opencode-mem.svg)](https://www.npmjs.com/package/opencode-mem)

![OpenCode Memory Banner](.github/banner.png)

A persistent memory system for AI coding agents that enables long-term context retention across sessions using local vector database technology.

## Visual Overview

**Project Memory Timeline:**

![Project Memory Timeline](.github/screenshot-project-memory.png)

**User Profile Viewer:**

![User Profile Viewer](.github/screenshot-user-profile.png)

## Core Features

Local vector database with SQLite + USearch-first vector indexing and ExactScan fallback, persistent project memories, automatic user profile learning, unified memory-prompt timeline, full-featured web UI, intelligent prompt-based memory extraction, multi-provider AI support (OpenAI, Anthropic), 12+ local embedding models, smart deduplication, and built-in privacy protection.

## Prerequisites

This plugin uses `USearch` for preferred in-memory vector indexing with automatic ExactScan fallback. No custom SQLite build or browser runtime shim is required.

**Recommended runtime:**

- Bun
- Standard OpenCode plugin environment

**Notes:**

- If `USearch` is unavailable or fails at runtime, the plugin automatically falls back to exact vector scanning.
- SQLite remains the source of truth; search indexes are rebuilt from SQLite data when needed.

## Getting Started

Add to your OpenCode configuration at `~/.config/opencode/opencode.json`:

```jsonc
{
  "plugin": ["opencode-mem"],
}
```

The plugin downloads automatically on next startup.

## Usage Examples

```typescript
memory({ mode: "add", content: "Project uses microservices architecture" });
memory({ mode: "search", query: "architecture decisions" });
memory({ mode: "search", query: "architecture decisions", scope: "all-projects" });
memory({ mode: "profile" });
memory({ mode: "list", limit: 10 });
```

Access the web interface at `http://127.0.0.1:4747` for visual memory browsing and management.

## Scope conventions

`scope` is a free-form string. The plugin does not interpret its
contents — any string is valid. For applications that share a
database across multiple surfaces, the recommended convention is:

```
scope := "<domain>:<type>:<id>"
  domain : application surface — e.g. "qna", "code", "ops"
  type   : entity kind          — e.g. "user", "channel"  (omitted when type == "org")
  id     : opaque application-defined identifier
```

Examples:

| Scope                | Meaning                                                  |
| -------------------- | -------------------------------------------------------- |
| `qna:user:U12345`    | Memories private to user U12345 in the QnA surface       |
| `qna:channel:C67890` | Memories shared in channel C67890 (QnA only)             |
| `qna:org`            | Org-wide memories on the QnA surface                     |
| `code:user:U12345`   | Memories private to U12345 in the code/streaming surface |

Reads can span scopes via the `scopes: string[]` argument; writes
target a single scope via `scope: string`.

## Session-default scope directive

If your application prepends a JSON block of the form:

```text
[opencode-mem]
{
  "domain": "qna",
  "default_write_scope": "qna:channel:C67890",
  "default_read_scopes": ["qna:user:U12345", "qna:channel:C67890", "qna:org"],
  "peer_domains": ["code"]
}
[/opencode-mem]
```

to the first system message of each session, the plugin will:

1. parse it out of the message (the LLM never sees the directive),
2. use those scopes as the per-call default when the tool is invoked
   without an explicit `scope`/`scopes` argument.

The directive is parsed once at session start; later messages are
left untouched. Malformed directives are silently ignored — they
must never break the chat.

## Configuration Essentials

Configure at `~/.config/opencode/opencode-mem.jsonc`:

```jsonc
{
  "storagePath": "~/.opencode-mem/data",
  "userEmailOverride": "user@example.com",
  "userNameOverride": "John Doe",
  "embeddingModel": "Xenova/nomic-embed-text-v1",
  "memory": {
    "defaultScope": "project",
  },
  "webServerEnabled": true,
  "webServerPort": 4747,

  "autoCaptureEnabled": true,
  "autoCaptureLanguage": "auto",

  "opencodeProvider": "anthropic",
  "opencodeModel": "claude-haiku-4-5-20251001",

  "showAutoCaptureToasts": true,
  "showUserProfileToasts": true,
  "showErrorToasts": true,

  "userProfileAnalysisInterval": 10,
  "maxMemories": 10,

  "compaction": {
    "enabled": true,
    "memoryLimit": 10,
  },
  "chatMessage": {
    "enabled": true,
    "maxMemories": 3,
    "excludeCurrentSession": true,
    "maxAgeDays": undefined,
    "injectOn": "first",
  },
}
```

### Remote storage (experimental)

Point opencode-mem at a remote database by adding a `storage` block to
`~/.config/opencode/opencode-mem.jsonc`:

```jsonc
{
  "storage": {
    "recordStore": { "kind": "postgres", "url": "env://DATABASE_URL", "poolSize": 4 },
    "vectorBackend": { "kind": "usearch" },
  },
}
```

`recordStore.kind` accepts `sqlite` (default), `postgres`, or `libsql`. `vectorBackend.kind` accepts `usearch` (default) or `exact-scan`. Valid combinations: any record store with `usearch` or `exact-scan`; `postgres` additionally supports `pgvector` (reserved for a future release).

To migrate from a local SQLite store to a remote backend:

```bash
opencode-mem-migrate --to postgres --url "$DATABASE_URL"
# or
opencode-mem-migrate --to libsql --url "libsql://your.turso.io" --auth-token "$TOKEN"
```

The migration is idempotent — re-running with `--resume` skips rows that already exist on the target.

For multi-agent / distributed deployments, see [`examples/README.md`](examples/README.md).

### Memory Scope

- `scope: "project"`: query only the current project. This is the default.
- `scope: "all-projects"`: query `search` / `list` across all project shards.
- `memory.defaultScope` sets the default query scope when no explicit scope is provided.

### Auto-Capture AI Provider

**Recommended:** Use any provider that is already authenticated in opencode (no separate API key needed in this plugin):

```jsonc
"opencodeProvider": "anthropic",
"opencodeModel": "claude-haiku-4-5-20251001",
```

The plugin issues structured-output requests to opencode's session API instead of calling provider endpoints directly, so opencode owns the auth, token refresh, and provider routing. Whatever you configured in opencode just works — Claude Pro/Max via OAuth, GitHub Copilot (personal & business), OpenAI / Anthropic API keys, custom providers, etc.

Supported providers: any provider listed by `opencode providers list` (e.g. `anthropic`, `openai`, `github-copilot`, ...).

**Fallback:** Manual API configuration (if not using opencodeProvider):

```jsonc
"memoryProvider": "openai-chat",
"memoryModel": "gpt-4o-mini",
"memoryApiUrl": "https://api.openai.com/v1",
"memoryApiKey": "sk-...",
```

**API Key Formats:**

```jsonc
"memoryApiKey": "sk-..."
"memoryApiKey": "file://~/.config/opencode/api-key.txt"
"memoryApiKey": "env://OPENAI_API_KEY"
```

Full documentation available in this README.

## Public Subpath Exports

In addition to the main plugin entry, `opencode-mem` exposes one stable subpath
that other opencode plugins can import directly. This avoids having to
reverse-engineer container-tag conventions when writing third-party tools that
read or write into the same memory store.

### `opencode-mem/tags`

Canonical container-tag helpers. The same functions opencode-mem itself uses
to scope auto-captured memories.

```ts
import { getProjectTagInfo, getUserTagInfo, getTags } from "opencode-mem/tags";

// Canonical project tag derived from cwd (git remote URL if present, else
// the project root path). Format: `opencode_project_<sha16>`.
const projectTag = getProjectTagInfo(process.cwd()).tag;

// Canonical user tag derived from `git config user.email`.
// Format: `opencode_user_<sha16>`.
const userTag = getUserTagInfo().tag;

// Both at once.
const { user, project } = getTags(process.cwd());
```

Tags produced by these helpers match what auto-capture writes, so third-party
plugins that call `POST /api/memories` will land in the same shards the rest
of the system already understands. Hand-rolled tags whose substring isn't
`_project_` or `_user_` end up in shadow shards that `/api/stats` and
`/api/memories` silently filter out — using these helpers avoids that pitfall.

## Development & Contribution

Build and test locally:

```bash
bun install
bun run build
bun run typecheck
bun run format
```

This project is actively seeking contributions to become the definitive memory plugin for AI coding agents. Whether you are fixing bugs, adding features, improving documentation, or expanding embedding model support, your contributions are critical. The codebase is well-structured and ready for enhancement. If you hit a blocker or have improvement ideas, submit a pull request - we review and merge contributions quickly.

## License & Links

MIT License - see LICENSE file

- **Repository**: https://github.com/tickernelz/opencode-mem
- **Issues**: https://github.com/tickernelz/opencode-mem/issues
- **OpenCode Platform**: https://opencode.ai

Inspired by [opencode-supermemory](https://github.com/supermemoryai/opencode-supermemory)
