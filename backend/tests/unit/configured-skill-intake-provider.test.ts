import { describe, expect, it } from "vitest";

import {
  ConfiguredSkillIntakeProvider,
  DatabaseSkillIntakeStateStore,
  InMemorySkillIntakeStateStore,
  type ConfiguredSkillIntakeAdapter,
} from "../../src/modules/chat/services/configuredSkillIntakeProvider.js";
import type { SkillDefinition } from "../../src/modules/skills/public.js";

const profileSkill: SkillDefinition = {
  name: "test.profile_collect",
  displayName: "Profile collect",
  description: "Collect a test profile through configured skill intake.",
  owner: "platform",
  executionClass: "interactive",
  supportedCallers: ["assistant"],
  requiredCapabilities: [],
  contractReferences: [],
  intake: {
    enabled: true,
    supportedCallers: ["assistant"],
    intent: {
      description: "Collect a contact email and numeric access code.",
      examples: ["Start profile setup"],
    },
    fields: [
      {
        name: "email",
        displayName: "email address",
        type: "email",
        required: true,
        sensitive: true,
      },
      {
        name: "access_code",
        displayName: "access code",
        type: "string",
        required: true,
        pattern: "^[0-9]{5}$",
      },
    ],
    confirmation: "none",
    interruptionPolicy: "pause_and_resume",
  },
  execution: {
    kind: "internal",
    adapter: "test_profile_collect",
  },
  diagnostics: {
    defined: true,
    shapeAware: false,
    strategyAware: false,
  },
  steps: [],
};

const createChatInput = (message: string, conversationId = "conversation-1") => ({
  workspaceId: "workspace-1",
  accountId: "account-1",
  agentId: "agent-1",
  conversationId,
  userMessageId: `message-${message}`,
  query: message,
  history: [],
});

const createProfileAdapter = (executions: Array<Record<string, unknown>> = []): ConfiguredSkillIntakeAdapter => ({
  skill: profileSkill,
  async shouldStart(input) {
    return input.query.includes("Start profile setup");
  },
  async extractFields(input, state) {
    if (input.query === "12345") {
      return { access_code: "12345" };
    }
    if (state.collected?.email && /^[0-9]+$/.test(input.query)) {
      return { access_code: input.query };
    }
    if (input.query === "alex@example.com" || input.query === "not-an-email") {
      return { email: input.query };
    }
    return {};
  },
  async composeAnswer(input) {
    expect(input.chat.query).toBeTypeOf("string");
    if (input.kind === "invalid") {
      return `Please provide a valid ${input.invalid[0]?.displayName}.`;
    }
    return `Please provide ${input.missing.map((field) => field.displayName).join(" and ")}.`;
  },
  async execute(input) {
    executions.push(input.collected);
    return {
      answer: `Profile ${input.collected.access_code} is ready.`,
      outputs: { profileStatus: "ready" },
    };
  },
});

class FakeSkillIntakeDatabase {
  readonly now = new Date("2026-05-04T10:00:00.000Z");
  readonly states = new Map<string, {
    id: string;
    workspace_id: string;
    conversation_id: string;
    skill_name: string;
    status: "active" | "paused" | "completed" | "expired";
    collected: Record<string, unknown>;
    missing: string[];
    expires_at: Date;
    last_prompted_field: string | null;
    updated_at: Date;
  }>();

  async query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    if (text.includes("SET status = 'expired'")) {
      for (const state of this.states.values()) {
        if (
          state.workspace_id === String(params[0]) &&
          state.conversation_id === String(params[1]) &&
          state.skill_name === String(params[2]) &&
          (state.status === "active" || state.status === "paused") &&
          state.expires_at.getTime() <= this.now.getTime()
        ) {
          state.status = "expired";
          state.collected = {};
          state.missing = [];
          state.last_prompted_field = null;
          state.updated_at = this.now;
        }
      }
      return [] as T[];
    }

    if (text.includes("FROM skill_intake_states")) {
      const row = [...this.states.values()]
        .filter((state) =>
          state.workspace_id === String(params[0]) &&
          state.conversation_id === String(params[1]) &&
          state.skill_name === String(params[2]) &&
          (state.status === "active" || state.status === "paused") &&
          state.expires_at.getTime() > this.now.getTime()
        )
        .sort((left, right) => right.updated_at.getTime() - left.updated_at.getTime())[0];
      return (row ? [row] : []) as T[];
    }

    if (text.includes("INSERT INTO skill_intake_states")) {
      const row = {
        id: String(params[0]),
        workspace_id: String(params[1]),
        conversation_id: String(params[2]),
        skill_name: String(params[3]),
        status: String(params[4]) as "active",
        collected: JSON.parse(String(params[5])) as Record<string, unknown>,
        missing: params[6] as string[],
        expires_at: new Date(String(params[7])),
        last_prompted_field: params[8] === null ? null : String(params[8]),
        updated_at: this.now,
      };
      this.states.set(row.id, row);
      return [row] as T[];
    }

    if (text.includes("UPDATE skill_intake_states")) {
      const row = this.states.get(String(params[0]));
      if (!row) {
        return [] as T[];
      }
      row.status = String(params[1]) as "active" | "paused" | "completed";
      row.collected = JSON.parse(String(params[2])) as Record<string, unknown>;
      row.missing = params[3] as string[];
      row.last_prompted_field = params[4] === null ? null : String(params[4]);
      row.updated_at = this.now;
      return [row] as T[];
    }

    return [] as T[];
  }
}

describe("configured skill intake provider", () => {
  it("collects multiple required fields across turns before executing a configured skill", async () => {
    const executions: Array<Record<string, unknown>> = [];
    const provider = new ConfiguredSkillIntakeProvider([createProfileAdapter(executions)]);

    const first = await provider.handle(createChatInput("Start profile setup"));
    expect(first).toMatchObject({
      skillName: "test.profile_collect",
      status: "active",
      answer: "Please provide email address and access code.",
    });
    expect(executions).toEqual([]);

    const second = await provider.handle(createChatInput("12345"));
    expect(second).toMatchObject({
      status: "active",
      answer: "Please provide email address.",
    });
    const stateAfterCode = await provider.getState({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      skillName: "test.profile_collect",
    });
    expect(stateAfterCode?.collected).toEqual({ access_code: "12345" });

    const invalid = await provider.handle(createChatInput("not-an-email"));
    expect(invalid).toMatchObject({
      status: "active",
      answer: "Please provide a valid email address.",
    });
    expect(executions).toEqual([]);

    const completed = await provider.handle(createChatInput("alex@example.com"));
    expect(completed).toMatchObject({
      status: "completed",
      answer: "Profile 12345 is ready.",
      activitySummary: expect.objectContaining({
        skillName: "test.profile_collect",
        outcome: "skill_completed",
      }),
    });
    expect(executions).toEqual([
      {
        access_code: "12345",
        email: "alex@example.com",
      },
    ]);
  });

  it("resumes paused flows, validates likely single-field attempts, and keeps state outside the provider instance", async () => {
    const store = new InMemorySkillIntakeStateStore();
    const adapter = createProfileAdapter();

    const firstProvider = new ConfiguredSkillIntakeProvider([adapter], { stateStore: store });
    await firstProvider.handle(createChatInput("Start profile setup"));
    await firstProvider.handle(createChatInput("alex@example.com"));
    expect(await firstProvider.handle(createChatInput("Tell me something else."))).toBeNull();

    const resumedProvider = new ConfiguredSkillIntakeProvider([adapter], { stateStore: store });
    const resumed = await resumedProvider.handle(createChatInput("Okay, Start profile setup again."));
    expect(resumed).toMatchObject({
      status: "active",
      answer: "Please provide access code.",
    });

    const invalid = await resumedProvider.handle(createChatInput("678"));
    expect(invalid).toMatchObject({
      status: "active",
      answer: "Please provide a valid access code.",
      activitySummary: expect.objectContaining({
        outcome: "intake_invalid",
      }),
    });

    const completed = await resumedProvider.handle(createChatInput("12345"));
    expect(completed).toMatchObject({
      status: "completed",
      answer: "Profile 12345 is ready.",
    });
  });

  it("expires stale database-backed states before resuming or inserting a new intake", async () => {
    const database = new FakeSkillIntakeDatabase();
    database.states.set("expired-state", {
      id: "expired-state",
      workspace_id: "workspace-1",
      conversation_id: "conversation-1",
      skill_name: "test.profile_collect",
      status: "active",
      collected: { email: "alex@example.com" },
      missing: ["email"],
      expires_at: new Date("2026-05-04T09:00:00.000Z"),
      last_prompted_field: "email",
      updated_at: new Date("2026-05-04T09:00:00.000Z"),
    });
    const provider = new ConfiguredSkillIntakeProvider([createProfileAdapter()], {
      stateStore: new DatabaseSkillIntakeStateStore(database),
    });

    const result = await provider.handle(createChatInput("Start profile setup"));

    expect(result).toMatchObject({
      skillName: "test.profile_collect",
      status: "active",
    });
    expect(database.states.get("expired-state")).toMatchObject({
      status: "expired",
      collected: {},
      missing: [],
      last_prompted_field: null,
    });
    expect([...database.states.values()].filter((state) => state.status === "active")).toHaveLength(1);
  });

  it("scrubs sensitive collected fields when database-backed intake completes", async () => {
    const database = new FakeSkillIntakeDatabase();
    const executions: Array<Record<string, unknown>> = [];
    const provider = new ConfiguredSkillIntakeProvider([createProfileAdapter(executions)], {
      stateStore: new DatabaseSkillIntakeStateStore(database),
    });

    await provider.handle(createChatInput("Start profile setup"));
    await provider.handle(createChatInput("alex@example.com"));
    const completed = await provider.handle(createChatInput("12345"));

    expect(completed).toMatchObject({
      status: "completed",
      answer: "Profile 12345 is ready.",
    });
    expect(executions).toEqual([
      {
        access_code: "12345",
        email: "alex@example.com",
      },
    ]);
    const [state] = [...database.states.values()];
    expect(state).toMatchObject({
      status: "completed",
      collected: {
        access_code: "12345",
      },
      missing: [],
    });
    expect(JSON.stringify(state?.collected)).not.toContain("alex@example.com");
  });
});
