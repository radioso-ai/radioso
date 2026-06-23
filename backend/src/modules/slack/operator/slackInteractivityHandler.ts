import type { SlackInstallationRecord, SlackInstallationRepositoryPort } from "../public.js";
import type { SlackOperatorIdentityResolver } from "./slackOperatorIdentityResolver.js";

export type SlackInteractivityCallbackType = "block_actions" | "view_submission" | "view_closed";

export type SlackInteractivityPayload = Record<string, unknown> & {
  type: SlackInteractivityCallbackType;
  team?: { id?: string };
  user?: { id?: string };
};

export interface SlackInteractivityHandlerPort {
  handleBlockActions(payload: SlackInteractivityPayload): Promise<void>;
  handleViewSubmission(payload: SlackInteractivityPayload): Promise<void>;
  handleViewClosed(payload: SlackInteractivityPayload): Promise<void>;
}

const readNestedString = (value: unknown, key: string): string | null =>
  value && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>)[key] === "string"
    ? (value as Record<string, string>)[key]
    : null;

export class SlackInteractivityHandler implements SlackInteractivityHandlerPort {
  constructor(private readonly options: {
    installations: Pick<SlackInstallationRepositoryPort, "findByTeamId">;
    identityResolver?: Pick<SlackOperatorIdentityResolver, "resolve">;
  }) {}

  async handleBlockActions(payload: SlackInteractivityPayload): Promise<void> {
    await this.resolveIdentityForPayload(payload);
    // TODO(095 Phase B/C): decode action_id/value and dispatch to decision or ownership resolver.
  }

  async handleViewSubmission(payload: SlackInteractivityPayload): Promise<void> {
    await this.resolveIdentityForPayload(payload);
    // TODO(095 Phase C): dispatch ownership_reply modal submissions.
  }

  async handleViewClosed(_payload: SlackInteractivityPayload): Promise<void> {
    // Slack sends this for modal lifecycle notification; no Phase A side effect.
  }

  private async resolveIdentityForPayload(payload: SlackInteractivityPayload): Promise<void> {
    if (!this.options.identityResolver) {
      return;
    }
    const teamId = readNestedString(payload.team, "id");
    const slackUserId = readNestedString(payload.user, "id");
    if (!teamId || !slackUserId) {
      return;
    }
    const installation: SlackInstallationRecord | null = await this.options.installations.findByTeamId(teamId);
    if (!installation) {
      return;
    }
    await this.options.identityResolver.resolve({ installation, slackUserId });
  }
}
