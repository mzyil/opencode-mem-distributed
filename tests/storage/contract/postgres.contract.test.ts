import { runRecordStoreContract } from "./record-store.contract.ts";
import { startPostgres } from "../testcontainer-helpers.ts";
import { PostgresRecordStore } from "../../../src/services/storage/record-stores/postgres-record-store.ts";

let stop: (() => Promise<void>) | null = null;

runRecordStoreContract({
  name: "postgres",
  async create() {
    const pg = await startPostgres();
    stop = pg.stop;
    const store = new PostgresRecordStore({ url: pg.url, ssl: false, poolSize: 2 });
    await store.init();
    return store;
  },
  async teardown() {
    if (stop) {
      await stop();
      stop = null;
    }
  },
});
