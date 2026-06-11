import { describe, expect, it } from "vitest";

import {
  ApplicationModuleCoordinator,
  createApplicationExtensionRegistry,
} from "../../src/app/composition/applicationModule.js";
import { createWebhookSendApplicationModule } from "../../src/app/composition/builtIn/webhookSendModule.js";
import { WEBHOOK_SEND_ACTION_TYPE } from "../../src/modules/chat/services/actions/webhookSendActionHandler.js";

const applyModule = () => {
  const registry = createApplicationExtensionRegistry();
  new ApplicationModuleCoordinator({
    logger: { error: () => {} },
    registry,
  }).apply([createWebhookSendApplicationModule()]);
  return registry;
};

describe("webhook send application module", () => {
  it("registers the webhook.send handler without turn-time capability blocking", () => {
    const registry = applyModule();

    expect(registry.actionHandlerRegistrations.map((registration) => registration.type)).toEqual([
      WEBHOOK_SEND_ACTION_TYPE,
    ]);
    expect(registry.actionHandlerRegistrations[0]?.requiredCapabilities).toEqual([]);
    expect(registry.actionHandlerRegistrations[0]?.handler).toBeTypeOf("function");
  });
});
