import { describe, expect, it } from "vitest";

import { sanitizeJournaledSkillResult } from "../../../src/modules/routines/approvalResumeEffectJournal.js";

describe("approval resume effect journal", () => {
  it("removes PostgreSQL-incompatible null characters before a completed result is stored", () => {
    expect(sanitizeJournaledSkillResult({
      status: "completed",
      answer: "sent\u0000",
      outputs: { receipt: "r\u0000" },
    })).toEqual({
      status: "completed",
      answer: "sent",
      outputs: { receipt: "r" },
    });
  });
});
