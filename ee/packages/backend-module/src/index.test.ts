import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createEnterpriseBackendModule } from "./index.js";
import type {
  ApplicationAccountCreatedHandler,
  ApplicationDatabaseMigrator,
  ApplicationManagedModelPolicyRegistration,
  ApplicationModuleRegistrationContext,
  ApplicationOrganizationCreationGuardRegistration,
  ApplicationRouteMount,
  ApplicationUsageLimitPolicyRegistration,
  PeriodicTaskRegistration,
} from "./radiosoModuleTypes.js";

const createCaptureContext = () => {
  const databaseMigrators: ApplicationDatabaseMigrator[] = [];
  const routeMounts: ApplicationRouteMount[] = [];
  const accountCreatedHandlers: ApplicationAccountCreatedHandler[] = [];
  const periodicTasks: PeriodicTaskRegistration[] = [];
  let usageLimitPolicy: ApplicationUsageLimitPolicyRegistration | undefined;
  let managedModelPolicy: ApplicationManagedModelPolicyRegistration | undefined;
  let organizationCreationGuard: ApplicationOrganizationCreationGuardRegistration | undefined;

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
    registerManagedModelPolicy(policy) {
      managedModelPolicy = policy;
    },
    registerOrganizationCreationGuard(guard) {
      organizationCreationGuard = guard;
    },
    registerContactHistoryProvider() {},
    registerAnswerFeedbackHistoryProvider() {
      throw new Error("answer feedback is registered by the OSS backend");
    },
    registerPeriodicTask(registration) {
      periodicTasks.push(registration);
    },
  };

  return {
    accountCreatedHandlers,
    context,
    databaseMigrators,
    periodicTasks,
    get usageLimitPolicy() {
      return usageLimitPolicy;
    },
    get managedModelPolicy() {
      return managedModelPolicy;
    },
    get organizationCreationGuard() {
      return organizationCreationGuard;
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
      "ee-billing",
      "ee-staff-console",
      "ee-usage-limits",
    ]);
    expect(capture.routeMounts.map((mount) => mount.path).sort()).toEqual([
      "/api/v1/ee/auth/google",
      "/api/v1/ee/billing",
      "/api/v1/ee/operator-console",
      "/api/v1/ee/usage-limits",
      "/api/v1/plans",
    ]);
    expect(capture.accountCreatedHandlers).toHaveLength(1);
    expect(capture.usageLimitPolicy).toBeTypeOf("function");
    expect(capture.managedModelPolicy).toBeTypeOf("function");
    expect(capture.organizationCreationGuard).toBeTypeOf("function");
    expect(capture.periodicTasks.map((task) => task.id).sort()).toEqual([
      "ee-billing-auto-top-up",
      "ee-usage-limit-alerts",
    ]);
    for (const task of capture.periodicTasks) {
      expect(task.intervalMs).toBe(60_000);
      expect(task.create).toBeTypeOf("function");
    }
  });

  // The usage-limit alert sweep moved off the API runtime (issue #1507) onto a generic
  // worker-task route, one per registerPeriodicTask id. The auto-top-up sweep was missed in
  // that move: it is registered here exactly the same way, but infra/terraform/scheduler.tf
  // only scheduled ee-usage-limit-alerts, so auto top-up never ran in production (no API
  // timer, no Cloud Scheduler push either). This reads the real registration — not a
  // hand-copied id list — so a future EE periodic task that forgets its own scheduler job
  // fails this test instead of silently never running in production.
  it("schedules a Cloud Scheduler job for every EE periodic task registration", () => {
    const capture = createCaptureContext();
    const module = createEnterpriseBackendModule();
    module.register?.(capture.context);

    expect(capture.periodicTasks.length).toBeGreaterThan(0);

    const schedulerConfig = readFileSync(
      fileURLToPath(new URL("../../../../infra/terraform/scheduler.tf", import.meta.url)),
      "utf8",
    );

    for (const task of capture.periodicTasks) {
      const route = `/internal/tasks/periodic-tasks/${task.id}/run`;
      expect(
        schedulerConfig.includes(route),
        `infra/terraform/scheduler.tf has no Cloud Scheduler job targeting ${route}, so the ` +
          `"${task.id}" periodic task never runs in production (no API timer, and this is ` +
          "its only push-driven trigger).",
      ).toBe(true);
    }
  });
});
