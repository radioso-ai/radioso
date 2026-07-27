import { runVectorAdapterConformance } from "./vector-adapter-conformance.js";
import { InMemoryVectorAdapter } from "../support/inMemoryVectorAdapter.js";

runVectorAdapterConformance("in-memory external-style", async () => ({
  adapter: new InMemoryVectorAdapter(),
}));
