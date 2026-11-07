import type {
  ConversationRoutineOperatorReach,
  RoutineOperatorBoundEffects,
} from "@radioso/conversation-contract";

import {
  notificationRecipientDeliverable,
  type NotificationRecipientPolicyPort,
} from "../../../operatorNotifications/public.js";
import type { AppLogger } from "../../../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../../../shared/observability/metrics/metricsRegistry.js";
import { CONTACT_SEND_ACTION_TYPE } from "../routines/contactRoutine.js";
import type { ConfiguredContactDeliveryResolver } from "./contactSendActionHandler.js";

interface RoutineOperatorReachScope {
  workspaceId: string;
  agentId: string;
}

/** Enough of the agent's skills to tell which of a turn's skill steps queued a contact request. */
interface SkillKindLookup {
  findByName(workspaceId: string, agentId: string, skillName: string): Promise<{ kind: string } | null>;
}

/** Whether the workspace's operator notices also post in a chat channel. */
interface EscalationChannelLookup {
  hasEscalationChannel(workspaceId: string): Promise<boolean>;
}

const NOTIFY_SKILL_KIND = "notify";

const carriesCompletionNotice = ({ terminal }: RoutineOperatorBoundEffects): boolean =>
  terminal?.kind === "complete" && terminal.operatorNotice !== undefined;

/**
 * Whether what a routine turn did can notify the team, read before its reply is written so the
 * reply does not claim a notification that delivery is going to skip (#1702). It asks the resolver
 * delivery uses and the recipient policy's `describe`, which reads state and sends nothing:
 * preparing a delivery can mail a confirmation link. A completion notice also posts in the
 * workspace's escalation channel; a contact request has no such path. The daily email cap and the
 * per-conversation dispatch cap are not predicted, and the turn's action still queues, since an
 * address can confirm before the worker runs.
 */
export class RoutineOperatorReachReader {
  constructor(private readonly options: {
    resolver: Pick<ConfiguredContactDeliveryResolver, "resolveForAgent">;
    recipientPolicy: Pick<NotificationRecipientPolicyPort, "describe">;
    skills: SkillKindLookup;
    logger: Pick<AppLogger, "warn">;
    metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
    /** Absent, no workspace has one. */
    escalationChannel?: EscalationChannelLookup;
  }) {}

  /** The check for one agent's turns, as the routine runner asks it. */
  forAgent(scope: RoutineOperatorReachScope): ConversationRoutineOperatorReach {
    return { canReachOperators: (effects) => this.canReach(scope, effects) };
  }

  private async canReach(scope: RoutineOperatorReachScope, effects: RoutineOperatorBoundEffects): Promise<boolean> {
    try {
      const routes = await this.routesOf(scope, effects);
      if (routes.length === 0) {
        return true;
      }
      const reached = await Promise.all(routes.map((skillName) => this.routeReachesSomeone(scope, skillName)));
      return reached.includes(true)
        || (carriesCompletionNotice(effects) && await this.options.escalationChannel?.hasEscalationChannel(scope.workspaceId) === true);
    } catch (error) {
      // The worker may still deliver, and a failed read must not have the agent tell visitors
      // that nothing was sent. The error itself can carry a connection string, so only its name.
      this.options.logger.warn(
        { ...scope, errorName: error instanceof Error ? error.name : "unknown" },
        "Routine operator reach could not be read; the reply keeps its wording",
      );
      this.options.metrics?.incrementCounter("routine_operator_reach_read_failures_total", {
        help: "Routine turns whose reply kept its wording because operator reach could not be read.",
      });
      return true;
    }
  }

  /**
   * The delivery routes of the effects that notify the team and leave no Inbox item, `null` for the
   * default route. A turn that ends in a hand-off has none: the conversation lands in the Inbox
   * whether or not an email goes out. A completion export is not addressed to the team.
   */
  private async routesOf(
    scope: RoutineOperatorReachScope,
    effects: RoutineOperatorBoundEffects,
  ): Promise<Array<string | null>> {
    const { actions = [], terminal, skillsWithExternalEffects = [] } = effects;
    if (terminal?.kind === "handoff" || terminal?.kind === "stuck") {
      return [];
    }
    const contactRequests = actions
      .filter((action) => action.type === CONTACT_SEND_ACTION_TYPE)
      .map((action) => action.skillName ?? null);
    const completionNotice = carriesCompletionNotice(effects)
      ? [terminal?.operatorNotice?.skillName ?? null]
      : [];
    return [...new Set([
      ...contactRequests,
      ...completionNotice,
      ...await this.notifySkillsAmong(scope, skillsWithExternalEffects),
    ])];
  }

  /** A notify skill step queues its own `contact.send`, routed through that skill, outside the turn's actions. */
  private async notifySkillsAmong(scope: RoutineOperatorReachScope, skillNames: readonly string[]): Promise<string[]> {
    const skills = await Promise.all(skillNames.map(async (skillName) => ({
      skillName,
      skill: await this.options.skills.findByName(scope.workspaceId, scope.agentId, skillName),
    })));
    return skills.filter(({ skill }) => skill?.kind === NOTIFY_SKILL_KIND).map(({ skillName }) => skillName);
  }

  /** A webhook or one address in a deliverable state is enough. */
  private async routeReachesSomeone(scope: RoutineOperatorReachScope, skillName: string | null): Promise<boolean> {
    const target = await this.options.resolver.resolveForAgent({ ...scope, skillName });
    if (target.webhook !== null) {
      return true;
    }
    const recipients = await this.options.recipientPolicy.describe(scope.workspaceId, target.emails);
    return recipients.some((recipient) => notificationRecipientDeliverable(recipient.state));
  }
}
