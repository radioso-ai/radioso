import type { Env } from "../../app/config/env.js";
import type { ApplicationModule } from "../../app/composition/applicationModule.js";
import { getSlackReadiness } from "./manifest/slackManifest.js";
import { buildSlackOauthProviderDefinition } from "./oauth/slackProvider.js";
import {
  SLACK_POST_ACTION_TYPE,
  SlackPostActionCredentialResolver,
  SlackPostActionHandler,
} from "./outbox/slackPostAction.js";

type SlackOauthEnv = Pick<Env, "SLACK_OAUTH_CLIENT_ID" | "SLACK_OAUTH_CLIENT_SECRET" | "SLACK_SIGNING_SECRET">;

export const createSlackApplicationModule = (env?: Partial<SlackOauthEnv>): ApplicationModule => ({
  id: "radioso-slack",
  name: "Radioso Slack",
  register(context) {
    if (getSlackReadiness(env).configured) {
      const provider = buildSlackOauthProviderDefinition({
        clientId: env?.SLACK_OAUTH_CLIENT_ID,
        clientSecret: env?.SLACK_OAUTH_CLIENT_SECRET,
      });
      if (provider) {
        context.registerOauthProvider(provider);
      }
    }
    context.registerActionHandler({
      type: SLACK_POST_ACTION_TYPE,
      handler: ({ database, env: runtimeEnv, logger }) =>
        new SlackPostActionHandler({
          credentials: new SlackPostActionCredentialResolver({
            database,
            encryptionKey: runtimeEnv.CONNECTOR_ENCRYPTION_KEY,
          }),
          logger,
        }),
    });
  },
});
