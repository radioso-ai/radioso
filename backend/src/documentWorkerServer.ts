import { getEnv } from "./app/config/env.js";
import { loadEnvFileIfPresent } from "./runtime/loadEnv.js";
import { startWorkerTaskRuntime } from "./runtime/startWorkerTaskRuntime.js";

loadEnvFileIfPresent();

const runtime = await startWorkerTaskRuntime({
  env: getEnv(),
});

process.once("SIGINT", () => {
  void runtime.shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void runtime.shutdown("SIGTERM");
});
