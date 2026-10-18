import { InMemoryStorage } from "./memory-storage";
import { runStorageContractSuite } from "../testing";

runStorageContractSuite("InMemoryStorage", (runtime) => ({
  storage: new InMemoryStorage(runtime),
}));

