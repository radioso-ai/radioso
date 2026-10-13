import type { ContactDeliveryRoute } from "../../../../shared/domain/contactDeliveryRoute.js";
import { isRoutineNamedSkill } from "../../../../shared/domain/routineNamedSkill.js";
import type { RoutedContactDeliveryTarget } from "./contactSendActionHandler.js";
import type {
  DailyNotificationEmailAllowance,
  NotificationEmailAllowanceReader,
  NotificationRecipientDescription,
  NotificationRecipientPolicyService,
} from "../../../operatorNotifications/public.js";

/** Where one choice of "Send with" delivers a routine ending's notice. */
interface OperatorNoticeDestination {
  /** The notify skill that sends it, or `null` for the default destination. */
  skillName: string | null;
  via: ContactDeliveryRoute;
  recipientEmails: string[];
  recipients: NotificationRecipientDescription[];
  recipientsFromWorkspaceOwner: boolean;
  /** A webhook also receives the notice. Its URL is never returned: it often carries a token. */
  webhookConfigured: boolean;
}

interface OperatorNoticeDestinations {
  default: OperatorNoticeDestination;
  skills: OperatorNoticeDestination[];
  /** Shared by every email destination: once it is used up, today's notices go to webhooks only. */
  dailyEmailAllowance: DailyNotificationEmailAllowance | null;
}

/** The agent's skills, enough to pick the notify skills a routine ending may name. */
interface OperatorNoticeSkillLister {
  listByAgent(workspaceId: string, agentId: string): Promise<Array<{
    skillName: string;
    kind: string;
    enabled: boolean;
    invocationMode: string;
  }>>;
}

/** The resolver delivery uses, so what an operator is shown is where a notice is sent. */
interface OperatorNoticeDestinationResolver {
  resolveForAgent(input: {
    workspaceId: string;
    agentId: string;
    skillName: string | null;
  }): Promise<RoutedContactDeliveryTarget>;
}

/**
 * Where a routine ending's "Notify the team" notice goes for this agent: the default destination
 * and each notify skill an ending may name. Recipient emails are personal data, so callers serve
 * this to workspace members only, never to machine principals.
 */
export class OperatorNoticeDestinationsReader {
  constructor(private readonly options: {
    skills: OperatorNoticeSkillLister;
    resolver: OperatorNoticeDestinationResolver;
    recipientPolicy?: Pick<NotificationRecipientPolicyService, "describe">;
    emailAllowance?: NotificationEmailAllowanceReader;
  }) {}

  async read(input: { workspaceId: string; agentId: string }): Promise<OperatorNoticeDestinations> {
    const skills = await this.options.skills.listByAgent(input.workspaceId, input.agentId);
    const nameable = skills
      .filter((skill) => skill.kind === "notify" && isRoutineNamedSkill(skill))
      .map((skill) => skill.skillName);
    const [defaultTarget, ...skillTargets] = await Promise.all(
      [null, ...nameable].map((skillName) => this.options.resolver.resolveForAgent({ ...input, skillName })),
    );
    const targets = [defaultTarget, ...skillTargets];
    const recipients = await Promise.all(targets.map((target) => this.options.recipientPolicy
      ? this.options.recipientPolicy.describe(input.workspaceId, target.emails)
      : Promise.resolve(target.emails.map((email) => ({ email, state: "confirmation_not_required" as const })))));
    const toDestination = (skillName: string | null, target: RoutedContactDeliveryTarget, index: number): OperatorNoticeDestination => ({
      skillName,
      via: target.via,
      recipientEmails: target.emails,
      recipients: recipients[index] ?? [],
      recipientsFromWorkspaceOwner: target.recipientsFromWorkspaceOwner,
      webhookConfigured: target.webhook !== null,
    });
    return {
      default: toDestination(null, defaultTarget, 0),
      skills: nameable.map((skillName, index) => toDestination(skillName, skillTargets[index], index + 1)),
      dailyEmailAllowance: await this.options.emailAllowance?.describeDailyEmailAllowance({ workspaceId: input.workspaceId }) ?? null,
    };
  }
}
