import { PLAN_CATALOG } from "@radioso/plan-catalog";

import type { ApplicationModule } from "../radiosoModuleTypes.js";

import { usageLimitMigrator } from "./usageLimitMigrator.js";
import { createUsageLimitRoutes } from "./usageLimitRoutes.js";
import { EnterpriseUsageLimitService } from "./usageLimitService.js";
import { EnterpriseOrganizationCreationGuard } from "../orgCreation/organizationCreationGuard.js";
import { createUsageLimitCopilotToolContribution } from "./copilotTools.js";
import { UsageLimitAlertDispatcher } from "./alerts/alertDispatcher.js";

// 60s: the design's own ceiling on alert latency ("sweep-only ... ≤1 min latency is fine for
// usage alerts"); the dispatcher itself bounds one run to at most 1,250 claims.
const ALERT_SWEEP_INTERVAL_MS = 60_000;

// The free plan in @radioso/plan-catalog: every new account starts here.
const DEFAULT_PROFILE_KEY = PLAN_CATALOG.defaultPlanId;

export const createUsageLimitsApplicationModule = (): ApplicationModule => ({
  id: "radioso-enterprise-usage-limits",
  name: "Radioso Enterprise Usage Limits",
  register(context) {
    context.registerDatabaseMigrator(usageLimitMigrator);
    context.registerUsageLimitPolicy(({ database }) => {
      return new EnterpriseUsageLimitService(database);
    });
    // The reviewed-operation import planner needs to explain document capacity before it plans
    // a batch write; that read lives on its own narrow port so `registerUsageLimitPolicy`'s
    // reservation fakes never have to stub it.
    context.registerDocumentCapacityReader?.(({ database }) => {
      return new EnterpriseUsageLimitService(database);
    });
    context.registerOrganizationCreationGuard?.(({ database }) => {
      return new EnterpriseOrganizationCreationGuard(database);
    });
    // The durable usage-event recorder is now an OSS default (registered in
    // backend composition). EE no longer registers its own to avoid a second
    // ledger path; it continues to own usage-LIMIT enforcement above.
    context.registerAccountCreatedHandler(async ({ accountId, database }) => {
      const resolvedService = new EnterpriseUsageLimitService(database);
      await resolvedService.assignProfile(accountId, DEFAULT_PROFILE_KEY);
    });
    context.registerRouteMount({
      path: "/api/v1/ee/usage-limits",
      createRouter(dependencies) {
        return createUsageLimitRoutes(dependencies);
      },
    });
    // Without this the plan an operator is billed against is invisible to Ray, which then advises
    // on ingestion volume with no idea what the account is allowed to store.
    context.registerCopilotTools?.(({ database }) =>
      createUsageLimitCopilotToolContribution({ usage: new EnterpriseUsageLimitService(database) }));
    // Sweep-only delivery (no post-commit trigger; see specs/usage-alerts design): a periodic
    // task in the API runtime claims due `ee_usage_limit_alerts` rows and sends them. Runs only
    // where `registerPeriodicTask` is wired (the API runtime), never the worker or migrator.
    context.registerPeriodicTask?.({
      id: "ee-usage-limit-alerts",
      intervalMs: ALERT_SWEEP_INTERVAL_MS,
      create(taskContext) {
        return new UsageLimitAlertDispatcher({
          database: taskContext.database,
          audit: taskContext.audit,
          noticeMail: taskContext.noticeMail,
          accountAdministrators: taskContext.accountAdministrators,
          appBaseUrl: taskContext.appBaseUrl,
          logger: taskContext.logger,
        });
      },
    });
  },
});
