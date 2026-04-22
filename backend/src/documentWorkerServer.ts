import { getEnv } from "./app/config/env.js";
import { loadEnvFileIfPresent } from "./runtime/loadEnv.js";
import { startWorkerTaskRuntime } from "./runtime/startWorkerTaskRuntime.js";

loadEnvFileIfPresent();

const env = getEnv();
const runtime = await startWorkerTaskRuntime({
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
