import type { AgentService } from "../../agents/public.js";
import { isAgentBootstrapActive } from "../../agents/public.js";
import {
  exactGreetingContent,
  resolveExactGreeting,
  resolveRevisionGreeting,
  type RevisionGreetingResolverPort,
} from "./agentRevisionGreeting.js";

import type { AgentStarterPrompt, AgentStarterPromptReader } from "../contracts/agentStarterPrompts.js";

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
