import { getEnv } from "./app/config/env.js";
import { loadEnvFileIfPresent } from "./runtime/loadEnv.js";
import { startWorkerRuntime } from "./runtime/startWorkerRuntime.js";

loadEnvFileIfPresent();

const env = getEnv();
const runtime = await startWorkerRuntime({
  env: process.env.OBSERVABILITY_SERVICE_NAME ? env : {
    ...env,
    OBSERVABILITY_SERVICE_NAME: "radioso-worker",
  },
});

process.once("SIGINT", () => {
  void runtime.shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void runtime.shutdown("SIGTERM");
});
