import { getEnv } from "./app/config/env.js";
import { loadEnvFileIfPresent } from "./runtime/loadEnv.js";
import { startWorkerRuntime } from "./runtime/startWorkerRuntime.js";

loadEnvFileIfPresent();

const runtime = await startWorkerRuntime({
  env: getEnv(),
});

process.once("SIGINT", () => {
  void runtime.shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void runtime.shutdown("SIGTERM");
});
