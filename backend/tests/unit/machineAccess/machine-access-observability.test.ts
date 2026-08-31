import { describe, expect, it } from "vitest";

import { buildAccessServices } from "../../../src/app/server/builders/accessAuth.js";
import { MetricsRegistry } from "../../../src/shared/observability/metrics/metricsRegistry.js";

describe("machine-access observability", () => {
  it("emits only bounded authentication and authorization labels", () => {
    const metricsRegistry = new MetricsRegistry();
    const access = buildAccessServices({
      auditService: {} as never,
      env: { WORKSPACE_TOKEN_SECRET: "test-secret" },
      logger: { warn() {} },
      metricsRegistry,
      repositories: {} as never,
    });

    access.machineAccessSecurityObserver.recordAuthentication({
      outcome: "denied",
      principalKind: "personal",
      reason: "expired",
    });
    access.machineAccessSecurityObserver.recordAuthorizationDenial({
      principalKind: "service",
      reason: "route_policy",
    });

    const output = metricsRegistry.renderPrometheus();
    expect(output).toContain('radioso_machine_access_authentication_total{outcome="denied",principal_kind="personal",reason="expired"} 1');
    expect(output).toContain('radioso_machine_access_authorization_denials_total{principal_kind="service",reason="route_policy"} 1');
    expect(output).not.toMatch(/credential_id=|workspace_id=|principal_id=|token_prefix=/);
  });
});
