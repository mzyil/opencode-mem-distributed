import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRecordStoreContract } from "./record-store.contract.ts";
import { SqliteRecordStore } from "../../../src/services/storage/record-stores/sqlite-record-store.ts";

let dir: string | null = null;

runRecordStoreContract({
  name: "sqlite",
  async create() {
    dir = mkdtempSync(join(tmpdir(), "ocmem-sqlite-"));
    process.env.OPENCODE_MEM_STORAGE_PATH = dir;
    const store = new SqliteRecordStore({ storagePath: dir, embeddingDimensions: 4 });
    await store.init();
    return store;
  },
  async teardown() {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
  },
});
