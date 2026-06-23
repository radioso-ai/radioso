import type { SkillExecutorRegistry } from "../../modules/skills/public.js";
import type { SkillCapabilityRegistry } from "../../modules/skills/capabilityRegistry.js";

export interface SkillCapabilityExecutorBinding {
  capabilityId: string;
  executorAdapter: string;
  bound: boolean;
}

export const bindSkillCapabilityExecutors = (input: {
  capabilities: SkillCapabilityRegistry;
  executors: SkillExecutorRegistry;
}): SkillCapabilityExecutorBinding[] =>
  input.capabilities.list().map((capability) => ({
    capabilityId: capability.id,
    executorAdapter: capability.executorAdapter,
    bound: Boolean(input.executors.resolve({ kind: "internal", adapter: capability.executorAdapter })),
  }));
