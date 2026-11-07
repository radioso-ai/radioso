import { describe, expect, it, vi } from "vitest";

import type { RoutineOperatorBoundEffects } from "@radioso/conversation-contract";

import { RoutineOperatorReachReader } from "../../src/modules/chat/services/actions/routineOperatorReach.js";
import type { RoutedContactDeliveryTarget } from "../../src/modules/chat/services/actions/contactSendActionHandler.js";
import { NotificationRecipientPolicyService } from "../../src/modules/operatorNotifications/public.js";
import type {
  NotificationRecipientDescription,
  NotificationRecipientStateStore,
  NotificationRecipientStateView,
} from "../../src/modules/operatorNotifications/public.js";

const scope = { workspaceId: "ws_1", agentId: "agent_1" };
const WEBHOOK = { url: "https://hooks.example.com/secret" };

const target = (emails: string[], webhook: RoutedContactDeliveryTarget["webhook"] = null): RoutedContactDeliveryTarget => ({
  emails,
  webhook,
  via: "agent_setting",
  recipientsFromWorkspaceOwner: false,
});

type RecipientState = NotificationRecipientDescription["state"];

/**
 * The real recipient policy over stored states, so the reader is tested against the rule delivery
 * applies. Asking it to prepare a delivery would send confirmation mail, so that call fails the test.
 */
const policyOver = (states: Record<string, Exclude<RecipientState, "confirmation_not_required">>, enabled = true) => {
  const sendConfirmation = vi.fn(async () => ({ dispatched: true }));
  const store: Pick<NotificationRecipientStateStore, "read"> = {
    read: async ({ emails }) => emails.flatMap((email): NotificationRecipientStateView[] => {
      const state = states[email];
      return state
        ? [{ email, state, grandfatheredUntil: state === "grandfathered" ? new Date(Date.now() + 86_400_000) : null, confirmationSentAt: null }]
        : [];
    }),
  };
  const service = new NotificationRecipientPolicyService({
    enabled,
    states: store as NotificationRecipientStateStore,
    sendConfirmation,
  });
  const prepareDelivery = vi.spyOn(service, "prepareDelivery");
  return { service, prepareDelivery, sendConfirmation };
};

const notice = (skillName?: string): RoutineOperatorBoundEffects["terminal"] => ({
  kind: "complete",
  stepId: "done",
  operatorNotice: skillName ? { skillName } : {},
});

const readerOver = (input: {
  targets: Record<string, RoutedContactDeliveryTarget>;
  states?: Record<string, Exclude<RecipientState, "confirmation_not_required">>;
  notifySkills?: readonly string[];
}) => {
  const resolveForAgent = vi.fn(async ({ skillName }: { skillName: string | null }) => {
    const resolved = input.targets[skillName ?? "default"];
    if (!resolved) throw new Error(`no route for ${skillName}`);
    return resolved;
  });
  const findByName = vi.fn(async (_workspaceId: string, _agentId: string, skillName: string) =>
    ({ kind: input.notifySkills?.includes(skillName) ? "notify" : "webhook" }));
  const logger = { warn: vi.fn() };
  const metrics = { incrementCounter: vi.fn() };
  const policy = policyOver(input.states ?? {});
  const reader = new RoutineOperatorReachReader({
    resolver: { resolveForAgent },
    recipientPolicy: policy.service,
    skills: { findByName },
    logger,
    metrics,
  });
  return { reach: reader.forAgent(scope), resolveForAgent, findByName, logger, metrics, policy };
};

describe("RoutineOperatorReachReader", () => {
  describe("a completion notice", () => {
    it.each<{ name: string; targets: Record<string, RoutedContactDeliveryTarget>; states: Record<string, Exclude<RecipientState, "confirmation_not_required">>; reachable: boolean }>([
      {
        name: "every recipient unconfirmed, revoked or suppressed: nobody can receive it",
        targets: { default: target(["a@example.com", "b@example.com", "c@example.com", "d@example.com"]) },
        states: { "a@example.com": "waiting_for_confirmation", "b@example.com": "revoked", "c@example.com": "suppressed" },
        reachable: false,
      },
      {
        name: "one confirmed recipient among the unconfirmed: one address is enough",
        targets: { default: target(["a@example.com", "b@example.com"]) },
        states: { "a@example.com": "waiting_for_confirmation", "b@example.com": "confirmed" },
        reachable: true,
      },
      {
        name: "a recipient kept on from before confirmation existed still receives notices",
        targets: { default: target(["a@example.com"]) },
        states: { "a@example.com": "grandfathered" },
        reachable: true,
      },
      {
        name: "a webhook alone reaches someone, whatever the recipients' state",
        targets: { default: target(["a@example.com"], WEBHOOK) },
        states: { "a@example.com": "revoked" },
        reachable: true,
      },
      {
        name: "a webhook with no recipients at all",
        targets: { default: target([], WEBHOOK) },
        states: {},
        reachable: true,
      },
      {
        name: "no recipients and no webhook",
        targets: { default: target([]) },
        states: {},
        reachable: false,
      },
    ])("$name", async ({ targets, states, reachable }) => {
      const { reach, policy } = readerOver({ targets, states });

      await expect(reach.canReachOperators({ terminal: notice() })).resolves.toBe(reachable);

      expect(policy.prepareDelivery).not.toHaveBeenCalled();
      expect(policy.sendConfirmation).not.toHaveBeenCalled();
    });

    it("reads the route of the notify skill the ending names, not the fallback", async () => {
      const { reach, resolveForAgent } = readerOver({
        targets: {
          default: target(["fallback@example.com"]),
          notify_bookings: target(["bookings@example.com"]),
        },
        states: { "fallback@example.com": "confirmed", "bookings@example.com": "waiting_for_confirmation" },
      });

      await expect(reach.canReachOperators({ terminal: notice("notify_bookings") })).resolves.toBe(false);

      expect(resolveForAgent).toHaveBeenCalledExactlyOnceWith({ ...scope, skillName: "notify_bookings" });
    });

    it("reads the fallback route when the ending names no skill", async () => {
      const { reach, resolveForAgent } = readerOver({
        targets: {
          default: target(["fallback@example.com"]),
          notify_bookings: target(["bookings@example.com"]),
        },
        states: { "fallback@example.com": "confirmed", "bookings@example.com": "waiting_for_confirmation" },
      });

      await expect(reach.canReachOperators({ terminal: notice() })).resolves.toBe(true);

      expect(resolveForAgent).toHaveBeenCalledExactlyOnceWith({ ...scope, skillName: null });
    });

    it("treats an address with no stored state as unconfirmed, as delivery does", async () => {
      const { reach } = readerOver({ targets: { default: target(["new@example.com"]) } });

      await expect(reach.canReachOperators({ terminal: notice() })).resolves.toBe(false);
    });

    it("follows the deployment's confirmation switch through the policy", async () => {
      const resolveForAgent = vi.fn(async () => target(["new@example.com"]));
      const reader = new RoutineOperatorReachReader({
        resolver: { resolveForAgent },
        recipientPolicy: policyOver({}, false).service,
        skills: { findByName: vi.fn(async () => null) },
        logger: { warn: vi.fn() },
      });

      await expect(reader.forAgent(scope).canReachOperators({ terminal: notice() })).resolves.toBe(true);
    });
  });

  describe("which effects count", () => {
    const nobody = { default: target([]) };

    it("counts contact.send, through its own skill route when it names one", async () => {
      const { reach, resolveForAgent } = readerOver({
        targets: { default: target(["a@example.com"]), notify_sales: target([]) },
        states: { "a@example.com": "confirmed" },
      });

      await expect(reach.canReachOperators({ actions: [{ type: "contact.send", payload: {} }] })).resolves.toBe(true);
      expect(resolveForAgent).toHaveBeenLastCalledWith({ ...scope, skillName: null });

      await expect(reach.canReachOperators({
        actions: [{ type: "contact.send", payload: {}, skillName: "notify_sales" }],
      })).resolves.toBe(false);
      expect(resolveForAgent).toHaveBeenLastCalledWith({ ...scope, skillName: "notify_sales" });
    });

    it("counts a notify skill step, which queues its own contact.send outside the turn's actions", async () => {
      const { reach, resolveForAgent, findByName } = readerOver({
        targets: { notify_sales: target(["sales@example.com"]) },
        notifySkills: ["notify_sales"],
      });

      await expect(reach.canReachOperators({
        skillsWithExternalEffects: ["crm_webhook", "notify_sales"],
      })).resolves.toBe(false);

      expect(findByName).toHaveBeenCalledWith(scope.workspaceId, scope.agentId, "crm_webhook");
      expect(resolveForAgent).toHaveBeenCalledExactlyOnceWith({ ...scope, skillName: "notify_sales" });
    });

    it("does not count a skill step that is not a notify skill: it reports its own result", async () => {
      const { reach, resolveForAgent } = readerOver({ targets: nobody });

      await expect(reach.canReachOperators({ skillsWithExternalEffects: ["crm_webhook"] })).resolves.toBe(true);

      expect(resolveForAgent).not.toHaveBeenCalled();
    });

    it.each([
      { name: "a hand-off notice", effects: { terminal: { kind: "handoff" as const, stepId: "person", operatorNotice: {} } } },
      { name: "a stuck ending", effects: { terminal: { kind: "stuck" as const, stepId: "ask", operatorNotice: {} } } },
      {
        name: "a contact request on the way to a hand-off",
        effects: {
          actions: [{ type: "contact.send", payload: {} }],
          terminal: { kind: "handoff" as const, stepId: "person" },
        },
      },
      { name: "an approval request", effects: { actions: [{ type: "approval.request", payload: {} }] } },
      { name: "a completion export", effects: { actions: [{ type: "webhook.send", payload: {} }] } },
      { name: "a completion with no notice", effects: { terminal: { kind: "complete" as const, stepId: "done" } } },
    ])("does not count $name: its wording stays true without an email", async ({ effects }) => {
      const { reach, resolveForAgent } = readerOver({ targets: nobody });

      await expect(reach.canReachOperators(effects)).resolves.toBe(true);

      expect(resolveForAgent).not.toHaveBeenCalled();
    });

    it("still reads a counted effect beside one that does not count", async () => {
      const { reach } = readerOver({ targets: nobody });

      await expect(reach.canReachOperators({
        actions: [{ type: "webhook.send", payload: {} }],
        terminal: notice(),
      })).resolves.toBe(false);
    });

    it("reports reachable when any counted route reaches someone, reading each route once", async () => {
      const { reach, resolveForAgent } = readerOver({
        targets: { default: target([]), notify_bookings: target(["bookings@example.com"]) },
        states: { "bookings@example.com": "confirmed" },
      });

      await expect(reach.canReachOperators({
        actions: [{ type: "contact.send", payload: {} }, { type: "contact.send", payload: {} }],
        terminal: notice("notify_bookings"),
      })).resolves.toBe(true);

      expect(resolveForAgent).toHaveBeenCalledTimes(2);
    });
  });

  describe("when the read fails", () => {
    it.each([
      { name: "the route", failing: "resolver" as const },
      { name: "the recipients' state", failing: "policy" as const },
      { name: "the skill lookup", failing: "skills" as const },
    ])("reports reachable when $name cannot be read, with a warning and a count that name nobody", async ({ failing }) => {
      const failure = new Error("connection to postgres://secret@db failed for a@example.com");
      const logger = { warn: vi.fn() };
      const metrics = { incrementCounter: vi.fn() };
      const policy = policyOver({});
      if (failing === "policy") {
        vi.spyOn(policy.service, "describe").mockRejectedValue(failure);
      }
      const reader = new RoutineOperatorReachReader({
        resolver: {
          resolveForAgent: failing === "resolver"
            ? vi.fn(async () => { throw failure; })
            : vi.fn(async () => target(["a@example.com"])),
        },
        recipientPolicy: policy.service,
        skills: {
          findByName: failing === "skills"
            ? vi.fn(async () => { throw failure; })
            : vi.fn(async () => ({ kind: "notify" })),
        },
        logger,
        metrics,
      });

      await expect(reader.forAgent(scope).canReachOperators({
        terminal: notice(),
        skillsWithExternalEffects: ["notify_sales"],
      })).resolves.toBe(true);

      expect(logger.warn).toHaveBeenCalledOnce();
      const [payload] = logger.warn.mock.calls[0];
      expect(payload).toMatchObject({ workspaceId: scope.workspaceId, agentId: scope.agentId, errorName: "Error" });
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("a@example.com");
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("secret");
      expect(metrics.incrementCounter).toHaveBeenCalledExactlyOnceWith(
        "routine_operator_reach_read_failures_total",
        expect.not.objectContaining({ labels: expect.anything() }),
      );
      expect(policy.prepareDelivery).not.toHaveBeenCalled();
    });

    it("does not count a healthy read as a failure", async () => {
      const { reach, metrics, logger } = readerOver({ targets: { default: target([]) } });

      await reach.canReachOperators({ terminal: notice() });

      expect(metrics.incrementCounter).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });
});
