import { Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // libSQL is SQLite-on-the-wire; use SQLite types.
  await db.schema
    .createTable("memories")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("scope", "text", (c) => c.notNull())
    .addColumn("scope_hash", "text", (c) => c.notNull())
    .addColumn("container_tag", "text", (c) => c.notNull())
    .addColumn("content", "text", (c) => c.notNull())
    .addColumn("tags", "text")
    .addColumn("type", "text")
    .addColumn("metadata", "text") // JSON-as-text; parsed at boundary
    .addColumn("display_name", "text")
    .addColumn("user_name", "text")
    .addColumn("user_email", "text")
    .addColumn("project_path", "text")
    .addColumn("project_name", "text")
    .addColumn("git_repo_url", "text")
    .addColumn("is_pinned", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("created_at", "integer", (c) => c.notNull())
    .addColumn("updated_at", "integer", (c) => c.notNull())
    .addColumn("session_id", "text") // explicit column instead of functional index
    .addColumn("vector_bytes", "blob")
    .addColumn("tags_vector_bytes", "blob")
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
      ON memories(scope, scope_hash, is_pinned) WHERE is_pinned = 1
  `.execute(db);
  await db.schema.createIndex("idx_memories_session").on("memories").column("session_id").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("memories").execute();
}
