import { runRecordStoreContract } from "./record-store.contract.ts";
import { LibsqlRecordStore } from "../../../src/services/storage/record-stores/libsql-record-store.ts";

runRecordStoreContract({
  name: "libsql",
  async create() {
    const store = new LibsqlRecordStore({ url: ":memory:" });
    await store.init();
    return store;
  },
  async teardown() {},
});
