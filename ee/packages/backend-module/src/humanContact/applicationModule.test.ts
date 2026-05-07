import { describe, expect, it, vi } from "vitest";

import { createHumanContactApplicationModule } from "./applicationModule.js";
import type { ApplicationModuleRegistrationContext, SkillDefinition } from "../radiosoModuleTypes.js";

describe("human contact application module", () => {
  it("registers the human contact request skill definition when installed", () => {
    const registeredSkills: SkillDefinition[] = [];
    const module = createHumanContactApplicationModule();

    module.register?.({
      registerDatabaseMigrator: vi.fn(),
      registerSkillDefinition(definition) {
        registeredSkills.push(definition);
      },
      registerChatActionProvider: vi.fn(),
      registerContactHistoryProvider: vi.fn(),
      registerRouteMount: vi.fn(),
      registerWebsiteEmbedIntegration: vi.fn(),
      registerUsageLimitPolicy: vi.fn(),
      registerAccountCreatedHandler: vi.fn(),
    } satisfies ApplicationModuleRegistrationContext);

    expect(registeredSkills).toEqual([
      expect.objectContaining({
        name: "human_contact.request",
        owner: "contact",
        diagnostics: {
          defined: true,
          shapeAware: true,
        },
        steps: expect.arrayContaining([
          expect.objectContaining({ name: "availability_check" }),
          expect.objectContaining({ name: "trigger_evaluation" }),
          expect.objectContaining({ name: "delivery_dispatch" }),
        ]),
      }),
    ]);
  });
});
