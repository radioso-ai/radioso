import { describe, expect, it } from "vitest";

import { createEnterpriseBackendModule } from "./index.js";
import type {
  ApplicationAccountCreatedHandler,
  ApplicationDatabaseMigrator,
  ApplicationModuleRegistrationContext,
  ApplicationRouteMount,
  ApplicationUsageLimitPolicyRegistration,
} from "./radiosoModuleTypes.js";

const createCaptureContext = () => {
  const databaseMigrators: ApplicationDatabaseMigrator[] = [];
  const routeMounts: ApplicationRouteMount[] = [];
  const accountCreatedHandlers: ApplicationAccountCreatedHandler[] = [];
  let usageLimitPolicy: ApplicationUsageLimitPolicyRegistration | undefined;

  const context: ApplicationModuleRegistrationContext = {
    registerDatabaseMigrator(migrator) {
      databaseMigrators.push(migrator);
    },
    registerRouteMount(mount) {
      routeMounts.push(mount);
    },
    registerAccountCreatedHandler(handler) {
      accountCreatedHandlers.push(handler);
    },
    registerUsageLimitPolicy(policy) {
      usageLimitPolicy = policy;
    },
    registerContactHistoryProvider() {},
    registerAnswerFeedbackHistoryProvider() {
      throw new Error("answer feedback is registered by the OSS backend");
    },
  };

  return {
    accountCreatedHandlers,
    context,
    databaseMigrators,
    get usageLimitPolicy() {
      return usageLimitPolicy;
    },
    routeMounts,
  };
};

describe("Enterprise backend module aggregation", () => {
  it("registers existing Enterprise contributions through feature modules", () => {
    const capture = createCaptureContext();
    const module = createEnterpriseBackendModule();

    module.register?.(capture.context);

    expect(module.id).toBe("radioso-enterprise-backend");
    expect(capture.databaseMigrators.map((migrator) => migrator.id).sort()).toEqual([
      "ee-usage-limits",
    ]);
    expect(capture.routeMounts.map((mount) => mount.path).sort()).toEqual([
      "/api/v1/ee/usage-limits",
    ]);
    expect(capture.accountCreatedHandlers).toHaveLength(1);
    expect(capture.usageLimitPolicy).toBeTypeOf("function");
  });
});
