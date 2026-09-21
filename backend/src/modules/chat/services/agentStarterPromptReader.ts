import type { AgentService } from "../../agents/public.js";
import { isAgentBootstrapActive } from "../../agents/public.js";
import {
  exactGreetingContent,
  resolveExactGreeting,
  resolveRevisionGreeting,
  type RevisionGreetingResolverPort,
} from "./agentRevisionGreeting.js";

export interface AgentStarterPrompt {
  label: string;
}

/**
 * Read-only view of the conversation starters an agent shows before its first
 * turn — the greeting chips the web embed renders. Channels that surface starters
 * outside a conversation (Slack's agent pane) read them here; nothing is started,
 * recorded, reserved, or generated.
 */
export interface AgentStarterPromptReader {
  listStarterPrompts(input: { workspaceId: string; agentId: string }): Promise<AgentStarterPrompt[]>;
}

/**
 * Starters come from the published revision's exact greeting (spec 1150), resolved
 * for the agent's default locale exactly as bootstrap resolves it. An automatic
 * greeting, a switched-off greeting, or an exact greeting without chips has none.
 */
export class RevisionGreetingStarterPromptReader implements AgentStarterPromptReader {
  constructor(
    private readonly agentService: Pick<AgentService, "resolve">,
    private readonly agentRevisionRuntimeResolver: RevisionGreetingResolverPort,
  ) {}

  async listStarterPrompts(input: { workspaceId: string; agentId: string }): Promise<AgentStarterPrompt[]> {
    const agent = await this.agentService.resolve(input.workspaceId, input.agentId);
    if (!isAgentBootstrapActive(agent)) {
      return [];
    }
    const exactContent = exactGreetingContent(
      await resolveRevisionGreeting(this.agentRevisionRuntimeResolver, {
        workspaceId: input.workspaceId,
        agent,
        trustedRevision: false,
      }),
    );
    if (!exactContent) {
      return [];
    }
    const outcome = resolveExactGreeting(exactContent, { agent, requestedLocale: null });
    return outcome.kind === "resolved" ? outcome.chips.map((chip) => ({ label: chip.label })) : [];
  }
}
