import { getEnv } from "./app/config/env.js";
import { loadEnvFileIfPresent } from "./runtime/loadEnv.js";
import { startApiRuntime } from "./runtime/startApiRuntime.js";

loadEnvFileIfPresent();

const runtime = await startApiRuntime({
  env: getEnv(),
});

process.once("SIGINT", () => {
  void runtime.shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void runtime.shutdown("SIGTERM");
});
