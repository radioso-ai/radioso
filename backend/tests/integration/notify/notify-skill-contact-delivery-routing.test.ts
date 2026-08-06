import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { NotifyExecutor } from "../../../src/modules/notify/notifyExecutor.js";
import {
  ActionDispatcher,
  ActionHandlerRegistry,
} from "../../../src/modules/chat/services/actions/actionDispatcher.js";
import {
  ConfiguredContactDeliveryResolver,
  ContactSendActionHandler,
  type ContactNotificationMailer,
} from "../../../src/modules/chat/services/actions/contactSendActionHandler.js";
import { CONTACT_SEND_ACTION_TYPE } from "../../../src/modules/chat/contracts/index.js";
import { InMemoryAgentSkillRepository } from "../../support/inMemoryAgentSkills.js";
import type {
  ActionFailureOutcome,
  ActionRequestRecord,
  EnqueueActionRequestInput,
} from "../../../src/db/repositories/actionRequestRepository.js";

/**
 * Minimal in-memory stand-in for `ActionRequestRepository`: just enough enqueue /
 * claim / mark semantics to drive a real producer -> outbox -> dispatcher -> handler
 * round trip without standing up Postgres. Not a general-purpose test double —
 * local to this file.
 */
class InMemoryActionOutbox {
  private readonly rows = new Map<string, ActionRequestRecord>();

  async enqueue(input: EnqueueActionRequestInput): Promise<{ id: string; duplicate: boolean }> {
    const id = randomUUID();
    this.rows.set(id, {
      id,
      type: input.type,
      payload: input.payload,
      workspaceId: input.workspaceId ?? null,
      accountId: input.accountId ?? null,
      conversationId: input.conversationId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      status: "pending",
      attempts: 0,
      skillName: input.skillName ?? null,
    });
    return { id, duplicate: false };
  }

  async claimPending(): Promise<ActionRequestRecord[]> {
    const claimed: ActionRequestRecord[] = [];
    for (const row of this.rows.values()) {
      if (row.status === "pending") {
        row.status = "in_progress";
        row.attempts += 1;
        claimed.push(row);
      }
    }
    return claimed;
  }

  async markDispatched(id: string): Promise<void> {
    const row = this.rows.get(id);
    if (row) {
      row.status = "dispatched";
    }
  }

  async recordFailure(id: string): Promise<ActionFailureOutcome> {
    const row = this.rows.get(id);
    if (row) {
      row.status = "failed";
    }
    return "failed";
  }
}

const emit = { emitStatus: async () => undefined, emitCustom: async () => undefined };

describe("notify skill contact delivery routing (enqueue through drain)", () => {
  it("routes two differently-named notify skills on the same agent to their own configured recipients", async () => {
    const outbox = new InMemoryActionOutbox();
    const skills = new InMemoryAgentSkillRepository();
    await skills.create({
      workspaceId: "ws_1",
      agentId: "agent_1",
      skillName: "contact_sales",
      kind: "notify",
      targetType: "notify_delivery",
      invocationMode: "routine_named",
      enabled: true,
      config: { delivery: { recipientEmails: ["sales@example.com"], webhook: null } },
    });
    await skills.create({
      workspaceId: "ws_1",
      agentId: "agent_1",
      skillName: "contact_support",
      kind: "notify",
      targetType: "notify_delivery",
      invocationMode: "routine_named",
      enabled: true,
      config: { delivery: { recipientEmails: ["support@example.com"], webhook: null } },
    });
    const executor = new NotifyExecutor({ skills, outbox });

    // Two visitors invoke two differently-named notify skills on the same agent.
    await executor.dispatch({
      skill: { name: "contact_sales" },
      collected: { message: "I want to buy 50 seats" },
      context: { workspaceId: "ws_1", agentId: "agent_1", conversationId: "conv_sales" },
      emit,
    });
    await executor.dispatch({
      skill: { name: "contact_support" },
      collected: { message: "My export is stuck" },
      context: { workspaceId: "ws_1", agentId: "agent_1", conversationId: "conv_support" },
      emit,
    });

    const sent: { to: string }[] = [];
    const mailer: ContactNotificationMailer = { send: async (message) => { sent.push({ to: message.to }); } };
    const conversations = {
      findByIdAndWorkspaceId: async () => ({ agentId: "agent_1" }),
    };
    // Agent-level delivery is deliberately empty, to prove the resolved recipients
    // come from each named skill, not this legacy fallback.
    const agents = {
      findByIdAndWorkspaceId: async () => ({ contactRequestDelivery: { recipientEmails: [], webhook: null } }),
    };
    const ownerFallback = { resolve: async () => ({ emails: ["owner@example.com"], webhook: null }) };
    const handler = new ContactSendActionHandler(
      mailer,
      new ConfiguredContactDeliveryResolver(conversations, agents, ownerFallback, skills),
    );
    const dispatcher = new ActionDispatcher(
      outbox,
      new ActionHandlerRegistry([{ type: CONTACT_SEND_ACTION_TYPE, handler }]),
    );

    await dispatcher.dispatchPending();

    expect(sent.map((message) => message.to).sort()).toEqual(["sales@example.com", "support@example.com"]);
  });
});
