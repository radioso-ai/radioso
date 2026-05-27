import type { SkillDefinition, SkillExecution } from "./domain.js";

export interface SkillExecutorInput {
  skill: SkillDefinition;
  collected: Record<string, unknown>;
  context?: Record<string, unknown>;
}

export interface SkillExecutorResult {
  answer: string;
  outputs?: Record<string, unknown>;
}

export interface SkillExecutorPort {
  execute(input: SkillExecutorInput): Promise<SkillExecutorResult>;
}

export type SkillExecutorDescriptor =
  | { kind: "internal"; adapter: string }
  | { kind: "delivery_pipeline"; adapter: string }
  | { kind: "webhook"; provider: "make" | "zapier" | "custom" };

export type SkillExecutorRegistration = SkillExecutorDescriptor & {
  executor: SkillExecutorPort;
};

const keyForDescriptor = (descriptor: SkillExecutorDescriptor): string => {
  switch (descriptor.kind) {
    case "internal":
    case "delivery_pipeline":
      return `${descriptor.kind}:${descriptor.adapter}`;
    case "webhook":
      return `webhook:${descriptor.provider}`;
  }
};

const keyForExecution = (execution: SkillExecution): string => {
  switch (execution.kind) {
    case "internal":
    case "delivery_pipeline":
      return `${execution.kind}:${execution.adapter}`;
    case "webhook":
      return `webhook:${execution.provider}`;
  }
};

export class SkillExecutorRegistry {
  private readonly executors = new Map<string, SkillExecutorPort>();

  constructor(registrations: SkillExecutorRegistration[] = []) {
    for (const registration of registrations) {
      this.register(registration);
    }
  }

  register(registration: SkillExecutorRegistration): void {
    const { executor, ...descriptor } = registration;
    const key = keyForDescriptor(descriptor);
    if (this.executors.has(key)) {
      throw new Error(`Skill executor for ${key} is already registered`);
    }
    this.executors.set(key, executor);
  }

  resolve(execution: SkillExecution): SkillExecutorPort | null {
    return this.executors.get(keyForExecution(execution)) ?? null;
  }
}
