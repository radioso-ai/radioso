import type { Env } from "../../app/config/env.js";
import type { ApplicationModule } from "../../app/composition/applicationModule.js";
import { buildCustomerEmailOauthProviderDefinitions } from "./oauthMailProviders.js";

type CustomerEmailOauthEnv = Pick<
  Env,
  | "GOOGLE_MAIL_OAUTH_CLIENT_ID"
  | "GOOGLE_MAIL_OAUTH_CLIENT_SECRET"
  | "MICROSOFT_GRAPH_MAIL_OAUTH_CLIENT_ID"
  | "MICROSOFT_GRAPH_MAIL_OAUTH_CLIENT_SECRET"
>;

export const createCustomerEmailApplicationModule = (env?: Partial<CustomerEmailOauthEnv>): ApplicationModule => ({
  id: "radioso-customer-email",
  name: "Radioso Customer Email",
  register(context) {
    const providers = buildCustomerEmailOauthProviderDefinitions({
      googleMailClientId: env?.GOOGLE_MAIL_OAUTH_CLIENT_ID,
      googleMailClientSecret: env?.GOOGLE_MAIL_OAUTH_CLIENT_SECRET,
      microsoftGraphMailClientId: env?.MICROSOFT_GRAPH_MAIL_OAUTH_CLIENT_ID,
      microsoftGraphMailClientSecret: env?.MICROSOFT_GRAPH_MAIL_OAUTH_CLIENT_SECRET,
    });
    for (const provider of providers) {
      context.registerOauthProvider(provider);
    }
  },
});
