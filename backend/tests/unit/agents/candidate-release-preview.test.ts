import { describe, expect, it } from "vitest";

import { describeCandidateReleasePreview } from "../../../src/modules/agents/candidateReleasePreview.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const when = new Date("2026-11-01T00:00:00.000Z");
const directive = (n: number, name: string, action: string, enabled = true) => ({ id: id(n), agentId: id(99), name, condition: { kind: "contextual", description: "visitor asks about a refund" }, action, enabled, createdAt: when, updatedAt: when });
const snapshot = (overrides: Record<string, unknown> = {}) => ({ customInstruction: "Be brief.", directives: [], routines: [], contextVariableEnablements: [], ...overrides }) as never;

describe("describeCandidateReleasePreview", () => {
  it("names a changed directive and shows its content, never its id or raw JSON", () => {
    const { rows, hidden } = describeCandidateReleasePreview(
      snapshot({ directives: [directive(1, "Refund tone", "Be formal")] }),
      snapshot({ directives: [directive(1, "Refund tone", "Stay warm")] }),
      40,
    );
    expect(hidden).toBe(0);
    expect(rows).toEqual([{ label: "Directive: Refund tone", before: { when: "visitor asks about a refund", then: "Be formal", enabled: true }, after: { when: "visitor asks about a refund", then: "Stay warm", enabled: true } }]);
    expect(JSON.stringify(rows)).not.toContain(id(1));
  });

  it("shows an added item with no before and a removed one with no after, and skips unchanged ones", () => {
    const { rows } = describeCandidateReleasePreview(
      snapshot({ directives: [directive(1, "Keep", "Same"), directive(2, "Old", "Gone")] }),
      snapshot({ directives: [directive(1, "Keep", "Same"), directive(3, "New", "Fresh")] }),
      40,
    );
    expect(rows.map((row) => [row.label, row.before === null, row.after === null])).toEqual([["Directive: Old", false, true], ["Directive: New", true, false]]);
  });

  it("counts the rows past the limit instead of dropping them silently", () => {
    const after = Array.from({ length: 5 }, (_, index) => directive(index + 1, `Directive ${index + 1}`, "Act"));
    const { rows, hidden } = describeCandidateReleasePreview(snapshot(), snapshot({ directives: after }), 2);
    expect(rows).toHaveLength(2);
    expect(hidden).toBe(3);
  });

  it("reads the first release as everything it adds, including the instruction", () => {
    const { rows } = describeCandidateReleasePreview(null, snapshot(), 40);
    expect(rows).toEqual([{ label: "Custom instruction", before: null, after: "Be brief." }]);
  });
});
