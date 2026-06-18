import type { Env } from "../../app/config/env.js";
import type { ApplicationModule } from "../../app/composition/applicationModule.js";
import { buildSlackOauthProviderDefinition } from "./oauth/slackProvider.js";

type SlackOauthEnv = Pick<Env, "SLACK_OAUTH_CLIENT_ID" | "SLACK_OAUTH_CLIENT_SECRET">;

export const createSlackApplicationModule = (env?: Partial<SlackOauthEnv>): ApplicationModule => ({
  id: "radioso-slack",
  name: "Radioso Slack",
  register(context) {
    const provider = buildSlackOauthProviderDefinition({
      clientId: env?.SLACK_OAUTH_CLIENT_ID,
      clientSecret: env?.SLACK_OAUTH_CLIENT_SECRET,
    });
    if (provider) {
      context.registerOauthProvider(provider);
    }
  },
});
