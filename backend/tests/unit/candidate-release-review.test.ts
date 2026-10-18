import { expect, it } from "vitest";
import { describeCandidateReleaseDiff } from "../../src/modules/agents/candidateReleaseReview.js";

// `describeCandidateReleaseDiff` only reads `id` (and, for instruction, string content) off these
// collections, but its parameter type requires a full `AgentRevisionSnapshot` whose `routines`
// entries are a complete `RoutineDefinition`. Building 41 valid routine definitions to exercise
// pagination would test schema construction, not the diff/paging logic this file covers, so the
// minimal stand-in shape is deliberately cast past the full snapshot type.
const snapshotFields = (instruction: string, routines: unknown[] = []) => ({ customInstruction: instruction, directives: [], routines, contextVariableEnablements: [] });
const snapshot = (instruction: string, routines: unknown[] = []) => snapshotFields(instruction, routines) as never;
it("reports same-count stable routine edits", () => expect(describeCandidateReleaseDiff(snapshot("x", [{ id: "r", name: "before" }]), snapshot("x", [{ id: "r", name: "after" }])).changes).toContainEqual(expect.objectContaining({ field: "routines", id: "r" })));
it("marks long instruction changes truncated", () => expect(describeCandidateReleaseDiff(snapshot(`${"a".repeat(300)}x`), snapshot(`${"a".repeat(300)}y`))).toMatchObject({ truncated: true }));
it("pages more than forty stable-id changes", () => { const rows = Array.from({ length: 41 }, (_, index) => ({ id: `r${index}` })); expect(describeCandidateReleaseDiff(snapshot("x", []), snapshot("x", rows), { offset: 40, limit: 40 })).toMatchObject({ changes: [expect.objectContaining({ id: "r40" })], nextOffset: null }); });
it("reports an equal-count agent skill change", () => expect(describeCandidateReleaseDiff({ ...snapshotFields("x"), agentSkills: [{ id: "skill-1", name: "before" }] } as never, { ...snapshotFields("x"), agentSkills: [{ id: "skill-1", name: "after" }] } as never).changes).toContainEqual(expect.objectContaining({ field: "agentSkills", id: "skill-1" })));
it("redacts agent skill config in summaries", () => { const result = describeCandidateReleaseDiff({ ...snapshotFields("x"), agentSkills: [{ id: "skill-1", config: { token: "SECRET" } }] } as never, { ...snapshotFields("x"), agentSkills: [{ id: "skill-1", config: { token: "OTHER" } }] } as never); expect(JSON.stringify(result)).not.toContain("SECRET"); expect(JSON.stringify(result)).toContain("configRedacted"); });
