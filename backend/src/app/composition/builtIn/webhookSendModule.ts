import { AgentRepository } from "../../../db/repositories/agentRepository.js";
import { ConversationRepository } from "../../../db/repositories/conversationRepository.js";
import {
  ConversationAgentWebhookPermissionResolver,
  FetchWebhookHttpClient,
  WebhookSendActionHandler,
  WEBHOOK_SEND_ACTION_TYPE,
} from "../../../modules/chat/composition.js";
import type { ApplicationModule } from "../applicationModule.js";

export const createWebhookSendApplicationModule = (): ApplicationModule => ({
  id: "radioso-webhook-send",
  name: "Radioso Webhook Send",
  register(context) {
    context.registerActionHandler({
      type: WEBHOOK_SEND_ACTION_TYPE,
      // The per-agent webhook-export gate is resolved at dispatch time from the
      // outbox conversation context. Keeping this empty prevents turn-time
      // authorization from blocking the visitor-facing reply.
      requiredCapabilities: [],
      handler: ({ database, logger, telemetryService, webhookDestinations, assertPublicWebsiteUrl }) => {
        return new WebhookSendActionHandler({
          destinations: webhookDestinations,
          deliveryOutcomes: webhookDestinations,
          permission: new ConversationAgentWebhookPermissionResolver(
            new ConversationRepository(database.kysely),
            new AgentRepository(database),
          ),
          httpClient: new FetchWebhookHttpClient(assertPublicWebsiteUrl),
          telemetryService,
          logger,
        });
      },
    });
  },
});
