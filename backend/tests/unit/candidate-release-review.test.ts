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

const greeting = (chipLabels: Record<string, string>, body = "Hello") => ({
  exactWordsEnabled: true,
  exactContent: { chips: Object.keys(chipLabels), variants: [{ locale: "en", body, chipLabels }] },
});
const withGreeting = (value: unknown) => ({ ...snapshotFields("x"), greeting: value }) as never;

it("reports a greeting-only change as one agent-level change", () => {
  const { changes } = describeCandidateReleaseDiff(snapshot("x"), withGreeting(greeting({ a: "Book" })));
  expect(changes).toEqual([{
    field: "greeting",
    id: "agent",
    before: JSON.stringify({ exactWordsEnabled: false, exactContent: null }),
    after: JSON.stringify(greeting({ a: "Book" })),
    truncated: false,
  }]);
});

it("reports no greeting change when an absent greeting meets the default", () =>
  expect(describeCandidateReleaseDiff(snapshot("x"), withGreeting({ exactWordsEnabled: false, exactContent: null })).changes).toEqual([]));

it("reports no greeting change when only chip label key order differs", () => {
  const left = greeting({ a: "Book", b: "Ask" });
  const right = { ...left, exactContent: { ...left.exactContent, variants: [{ locale: "en", body: "Hello", chipLabels: { b: "Ask", a: "Book" } }] } };
  expect(describeCandidateReleaseDiff(withGreeting(left), withGreeting(right)).changes).toEqual([]);
});

it("reports a change to a field the greeting gains later, not only the fields the review lists", () => {
  const withField = (tone: string) => withGreeting({ ...greeting({ a: "Book" }), exactContent: { ...greeting({ a: "Book" }).exactContent, variants: [{ locale: "en", body: "Hello", chipLabels: { a: "Book" }, tone }] } });
  expect(describeCandidateReleaseDiff(withField("formal"), withField("casual")).changes).toEqual([expect.objectContaining({ field: "greeting", id: "agent" })]);
});

it("shows no before value for a greeting on a first publish", () =>
  expect(describeCandidateReleaseDiff(null, withGreeting(greeting({ a: "Book" }))).changes.find((change) => change.field === "greeting")).toMatchObject({ before: null }));
