import { describe, expect, it, vi } from "vitest";

import { OperatorNoticeDestinationsReader } from "../../src/modules/chat/services/actions/operatorNoticeDestinations.js";
import type { RoutedContactDeliveryTarget } from "../../src/modules/chat/services/actions/contactSendActionHandler.js";

const skill = (skillName: string, overrides: { kind?: string; enabled?: boolean; invocationMode?: string } = {}) => ({
  skillName,
  kind: overrides.kind ?? "notify",
  enabled: overrides.enabled ?? true,
  invocationMode: overrides.invocationMode ?? "routine_named",
});

describe("OperatorNoticeDestinationsReader", () => {
  it("shows where the default destination and each nameable notify skill send, through the delivery resolver", async () => {
    const targets: Record<string, RoutedContactDeliveryTarget> = {
      default: { emails: ["owner@ananda.example"], webhook: null, via: "workspace_owner", recipientsFromWorkspaceOwner: true },
      notify_bookings: {
        emails: ["francesco@ananda.example"],
        webhook: { url: "https://hooks.example.com/secret" },
        via: "named_skill",
        recipientsFromWorkspaceOwner: false,
      },
    };
    const resolveForAgent = vi.fn(async ({ skillName }: { skillName: string | null }) => targets[skillName ?? "default"]);
    const reader = new OperatorNoticeDestinationsReader({
      skills: {
        listByAgent: async () => [
          skill("notify_bookings"),
          skill("notify_off", { enabled: false }),
          skill("notify_agentic", { invocationMode: "agent_selectable" }),
          skill("send_email", { kind: "email" }),
        ],
      },
      resolver: { resolveForAgent },
    });

    const destinations = await reader.read({ workspaceId: "ws_1", agentId: "agent_1" });

    expect(destinations).toEqual({
      default: {
        skillName: null,
        via: "workspace_owner",
        recipientEmails: ["owner@ananda.example"],
        recipientsFromWorkspaceOwner: true,
        webhookConfigured: false,
      },
      skills: [{
        skillName: "notify_bookings",
        via: "named_skill",
        recipientEmails: ["francesco@ananda.example"],
        recipientsFromWorkspaceOwner: false,
        webhookConfigured: true,
      }],
    });
    expect(resolveForAgent).toHaveBeenCalledWith({ workspaceId: "ws_1", agentId: "agent_1", skillName: null });
    expect(resolveForAgent).toHaveBeenCalledWith({ workspaceId: "ws_1", agentId: "agent_1", skillName: "notify_bookings" });
    expect(JSON.stringify(destinations)).not.toContain("hooks.example.com");
  });
});
