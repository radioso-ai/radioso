import type { SkillDisplayMetadata } from "../../skills/public.js";

export interface PublicChatIntakeAction {
  skillName: string;
  intentName: string;
  display?: SkillDisplayMetadata;
}

export interface PublicChatActionAdvertiserPort {
  getPublicIntakeActions(input: {
    workspaceId: string;
    agentId?: string | null;
    sourceChannel?: string | null;
  }): Promise<PublicChatIntakeAction[]>;
}

export class NoopPublicChatActionAdvertiser implements PublicChatActionAdvertiserPort {
  async getPublicIntakeActions(): Promise<PublicChatIntakeAction[]> {
    return [];
  }
}

export class ChainedPublicChatActionAdvertiser implements PublicChatActionAdvertiserPort {
  constructor(private readonly providers: PublicChatActionAdvertiserPort[]) {}

  async getPublicIntakeActions(input: Parameters<PublicChatActionAdvertiserPort["getPublicIntakeActions"]>[0]): Promise<PublicChatIntakeAction[]> {
    const actions = await Promise.all(
      this.providers.map((provider) => provider.getPublicIntakeActions(input)),
    );
    const seen = new Set<string>();
    return actions.flat().filter((action) => {
      const key = `${action.skillName}:${action.intentName}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }
}
