import { createRealtimeComposition } from "./app/composition/realtimeComposition.js";
import { createLogger } from "./shared/observability/logger.js";
import { loadEnvFileIfPresent } from "./runtime/loadEnv.js";
import { parseRealtimeRuntimeEnv } from "./runtime/realtimeRuntimeEnv.js";
import { runRealtimeProcess } from "./runtime/runRealtimeProcess.js";
import { startRealtimeRuntime } from "./runtime/startRealtimeRuntime.js";
import { startRuntimeTracing, stopRuntimeTracing } from "./runtime/tracing.js";

loadEnvFileIfPresent();

const runtimeEnv = parseRealtimeRuntimeEnv(process.env);
if (runtimeEnv.enabled) {
  await runRealtimeProcess({
    process,
    start: async (signal) => {
      const logger = createLogger();
      startRuntimeTracing(runtimeEnv.tracing, logger, "realtime");
      const composition = createRealtimeComposition({
        config: runtimeEnv.config,
        databaseUrl: runtimeEnv.databaseUrl,
        logger,
        port: runtimeEnv.port,
        sessionCookieName: runtimeEnv.sessionCookieName,
        stopTracing: stopRuntimeTracing,
      });
      const runtime = await startRealtimeRuntime({
        config: runtimeEnv.config,
        databaseConnectionString: runtimeEnv.databaseUrl,
        dependencies: composition.dependencies,
        signal,
      });
      composition.setRuntime(runtime);
      return runtime;
    },
  });
}
