import { describe, expect, it } from "vitest";

import { RetrieveRoutineSkillResolver } from "../../../src/modules/retrieval/services/retrieveRoutineSkillResolver.js";
import { RETRIEVAL_ANSWER_ADAPTER } from "../../../src/modules/retrieval/public.js";

describe("RetrieveRoutineSkillResolver", () => {
  it("resolves enabled named retrieve skills with routine_named mode", async () => {
    const resolver = new RetrieveRoutineSkillResolver([
      {
        skillName: "retrieve_events",
        enabled: true,
        invocationMode: "routine_named",
        config: {
          sourceScope: { sourceIds: ["2e0c6264-f2c4-4549-bcd8-bf2f7d1a0d1e"] },
          instruction: "Use event sources only.",
          exposedInputs: { query: true },
        },
      },
      {
        skillName: "answer",
        enabled: true,
        invocationMode: "default_answer",
        config: { sourceScope: "all", exposedInputs: { query: true } },
      },
    ]);

    expect(resolver.resolve("answer")).toBeNull();
    expect(resolver.resolve("retrieve_events")).toMatchObject({
      name: "retrieve_events",
      execution: { kind: "internal", adapter: RETRIEVAL_ANSWER_ADAPTER },
      metadata: {
        retrieveConfig: {
        instruction: "Use event sources only.",
        },
      },
    });
  });
});
