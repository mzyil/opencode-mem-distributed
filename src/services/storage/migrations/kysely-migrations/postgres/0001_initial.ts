import { Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("memories")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("scope", "text", (c) => c.notNull())
    .addColumn("scope_hash", "text", (c) => c.notNull())
    .addColumn("container_tag", "text", (c) => c.notNull())
    .addColumn("content", "text", (c) => c.notNull())
    .addColumn("tags", "text")
    .addColumn("type", "text")
    .addColumn("metadata", "jsonb")
    .addColumn("display_name", "text")
    .addColumn("user_name", "text")
    .addColumn("user_email", "text")
    .addColumn("project_path", "text")
    .addColumn("project_name", "text")
    .addColumn("git_repo_url", "text")
    .addColumn("is_pinned", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("created_at", "bigint", (c) => c.notNull())
    .addColumn("updated_at", "bigint", (c) => c.notNull())
    .addColumn("vector_bytes", "bytea")
    .addColumn("tags_vector_bytes", "bytea")
    .execute();

  await db.schema
    .createIndex("idx_memories_scope")
    .on("memories")
    .columns(["scope", "scope_hash"])
    .execute();
  await db.schema
    .createIndex("idx_memories_container")
    .on("memories")
    .columns(["scope", "scope_hash", "container_tag"])
    .execute();
  await db.schema
    .createIndex("idx_memories_type")
    .on("memories")
    .columns(["scope", "scope_hash", "type"])
    .execute();
  await db.schema
    .createIndex("idx_memories_created")
    .on("memories")
    .columns(["created_at desc" as any])
    .execute();
  await sql`
    CREATE INDEX idx_memories_pinned
      ON memories(scope, scope_hash, is_pinned) WHERE is_pinned
  `.execute(db);
  await sql`
    CREATE INDEX idx_memories_session
      ON memories ((metadata->>'sessionID'))
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("memories").execute();
}
