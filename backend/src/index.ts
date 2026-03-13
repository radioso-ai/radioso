import { getEnv } from "./app/config/env.js";
import { createApp } from "./app/server/createApp.js";
import { buildDependencies } from "./app/server/dependencies.js";

const env = getEnv();
const dependencies = buildDependencies(env);
const app = createApp(dependencies);

app.listen(env.PORT, () => {
  dependencies.logger.info({ port: env.PORT }, "Hivec backend listening");
});
