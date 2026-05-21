// src/services/storage/record-stores/codecs.ts
import type { MemoryRow } from "../types.js";

export function vectorToBuffer(v: Float32Array | null): Buffer | null {
  if (!v) return null;
  return Buffer.from(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}

export function bufferToVector(
  b: Buffer | Uint8Array | ArrayBuffer | null | undefined
): Float32Array {
  if (!b) return new Float32Array();
  if (b instanceof ArrayBuffer) return new Float32Array(b.slice(0));
  const u = b instanceof Buffer ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : b;
  return new Float32Array(u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength));
}

export function parseTags(s: string | null | undefined): string[] | null {
  if (!s) return null;
  return String(s).split(",");
}

export function joinTags(tags: string[] | null | undefined): string | null {
  if (!tags || tags.length === 0) return null;
  return tags.join(",");
}

export function parseMetadata(m: unknown): Record<string, unknown> | null {
  if (m == null) return null;
  if (typeof m === "string") {
    try {
      return JSON.parse(m) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return m as Record<string, unknown>;
}

export function serializeMetadata(m: Record<string, unknown> | null): string | null {
  return m ? JSON.stringify(m) : null;
}

export function sessionIdFromMetadata(m: Record<string, unknown> | null): string | null {
  if (!m) return null;
  const v = m["sessionID"];
  return typeof v === "string" ? v : null;
}

export function rowFromDb(row: any, vectorField: string, tagsVectorField: string): MemoryRow {
  return {
    id: row.id,
    content: row.content,
    containerTag: row.container_tag,
    tags: parseTags(row.tags),
    type: row.type ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    metadata: parseMetadata(row.metadata),
    displayName: row.display_name ?? null,
    userName: row.user_name ?? null,
    userEmail: row.user_email ?? null,
    projectPath: row.project_path ?? null,
    projectName: row.project_name ?? null,
    gitRepoUrl: row.git_repo_url ?? null,
    isPinned: row.is_pinned === true || row.is_pinned === 1,
    vector: bufferToVector(row[vectorField]),
    tagsVector: row[tagsVectorField] ? bufferToVector(row[tagsVectorField]) : null,
  };
}
