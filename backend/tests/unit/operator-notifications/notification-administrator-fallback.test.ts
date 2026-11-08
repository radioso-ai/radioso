import { describe, expect, it, vi } from "vitest";

import { NotificationAdministratorFallback } from "../../../src/modules/operatorNotifications/public.js";

const WORKSPACE = "00000000-0000-4000-8000-0000000000aa";
const AGENT = "00000000-0000-4000-8000-0000000000cc";
const LINK = "https://app.example.com/w/front/agents/front-desk";

const fallbackWith = (options: {
  administrators?: string[];
  dashboardUrl?: (input: { workspaceId: string; agentId: string | null }) => Promise<string | null>;
} = {}) => {
  const listAdministratorEmails = vi.fn(async (_workspaceId: string) => options.administrators ?? ["owner@example.com"]);
  const dashboardUrl = vi.fn(options.dashboardUrl ?? (async () => LINK));
  const unsubscribeUrl = vi.fn(async (_workspaceId: string, email: string) => `https://api.example.com/stop/${email}`);
  return {
    fallback: new NotificationAdministratorFallback({
      administrators: { listAdministratorEmails },
      unsubscribeLinks: { unsubscribeUrl },
      dashboardUrl,
    }),
    listAdministratorEmails,
    dashboardUrl,
    unsubscribeUrl,
  };
};

describe("NotificationAdministratorFallback", () => {
  it("sends to the workspace's administrators, saying which address missed the notice, why, and where to fix it", async () => {
    const { fallback, listAdministratorEmails, dashboardUrl, unsubscribeUrl } = fallbackWith({ administrators: ["owner@example.com", "admin@example.com"] });

    const plan = await fallback.plan({
      workspaceId: WORKSPACE,
      agentId: AGENT,
      skipped: [{ email: "reception@example.com", reason: "unconfirmed" }],
    });

    expect(listAdministratorEmails).toHaveBeenCalledWith(WORKSPACE);
    expect(dashboardUrl).toHaveBeenCalledWith({ workspaceId: WORKSPACE, agentId: AGENT });
    expect(unsubscribeUrl).toHaveBeenCalledWith(WORKSPACE, "owner@example.com");
    // Each copy carries the one-click stop link a configured address's copy does, for its own address.
    expect(plan?.recipients).toEqual([
      { email: "owner@example.com", listUnsubscribeUrl: "https://api.example.com/stop/owner@example.com" },
      { email: "admin@example.com", listUnsubscribeUrl: "https://api.example.com/stop/admin@example.com" },
    ]);
    expect(plan?.note).toBe(
      "This notification came to you because reception@example.com cannot receive it: the address has not confirmed yet "
        + `that it wants notifications. Fix it on the agent's page: ${LINK}`,
    );
    expect(plan?.note).not.toContain("\n");
  });

  it("names every address that missed the notice, each with its own reason", async () => {
    const { fallback } = fallbackWith();

    const plan = await fallback.plan({
      workspaceId: WORKSPACE,
      agentId: AGENT,
      skipped: [
        { email: "reception@example.com", reason: "unconfirmed" },
        { email: "desk@example.com", reason: "revoked" },
        { email: "bounced@example.com", reason: "suppressed" },
      ],
    });

    expect(plan?.note).toContain("none of its addresses can receive it");
    expect(plan?.note).toContain("reception@example.com: the address has not confirmed yet that it wants notifications");
    expect(plan?.note).toContain("desk@example.com: its owner stopped notifications from this workspace");
    expect(plan?.note).toContain("bounced@example.com: an earlier email to it bounced or was reported as spam");
  });

  it("leaves the link out when the deployment has none or it cannot be built", async () => {
    const none = await fallbackWith({ dashboardUrl: async () => null }).fallback.plan({
      workspaceId: WORKSPACE, agentId: AGENT, skipped: [{ email: "reception@example.com", reason: "unconfirmed" }],
    });
    const broken = await fallbackWith({ dashboardUrl: async () => { throw new Error("workspace lookup failed"); } }).fallback.plan({
      workspaceId: WORKSPACE, agentId: AGENT, skipped: [{ email: "reception@example.com", reason: "unconfirmed" }],
    });

    expect(none?.note).not.toContain("Fix it");
    expect(broken?.note).toBe(none?.note);
  });

  it("links to the workspace's agents when the notice names no real agent", async () => {
    const { fallback, dashboardUrl } = fallbackWith();

    await fallback.plan({ workspaceId: WORKSPACE, agentId: "unknown", skipped: [{ email: "reception@example.com", reason: "unconfirmed" }] });

    expect(dashboardUrl).toHaveBeenCalledWith({ workspaceId: WORKSPACE, agentId: null });
  });

  it("plans nothing when no administrator can be mailed", async () => {
    const { fallback, dashboardUrl } = fallbackWith({ administrators: [] });

    expect(await fallback.plan({
      workspaceId: WORKSPACE, agentId: AGENT, skipped: [{ email: "reception@example.com", reason: "unconfirmed" }],
    })).toBeNull();
    expect(dashboardUrl).not.toHaveBeenCalled();
  });
});
