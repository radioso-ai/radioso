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
const agentSkill = (overrides: Record<string, unknown> = {}) => ({
  id: "33333333-3333-4333-8333-333333333333", agentId: "22222222-2222-4222-8222-222222222222", workspaceId: "11111111-1111-4111-8111-111111111111",
  skillName: "lookup_orders", kind: "mcp_tool", invocationMode: "agent_selectable", enabled: true, targetType: "mcp_connection", targetId: null,
  config: { toolName: "lookup_orders" }, createdAt: new Date("2026-11-01T09:00:00.000Z"), updatedAt: new Date("2026-11-01T09:00:00.000Z"), ...overrides,
});
const withAgentSkills = (agentSkills: unknown[] | undefined) => ({ ...snapshotFields("x"), ...(agentSkills ? { agentSkills } : {}) }) as never;
it("reports an equal-count agent skill change", () => expect(describeCandidateReleaseDiff(withAgentSkills([agentSkill()]), withAgentSkills([agentSkill({ enabled: false })])).changes).toContainEqual(expect.objectContaining({ field: "agentSkills", id: "33333333-3333-4333-8333-333333333333" })));
it("redacts agent skill config in summaries", () => { const result = describeCandidateReleaseDiff(withAgentSkills([agentSkill({ config: { token: "SECRET" } })]), withAgentSkills([agentSkill({ config: { token: "OTHER" } })])); expect(result.changes).toHaveLength(1); expect(JSON.stringify(result)).not.toContain("SECRET"); expect(JSON.stringify(result)).toContain("configRedacted"); });
it("names a skill change by the skill's name", () => {
  const [change] = describeCandidateReleaseDiff(withAgentSkills([]), withAgentSkills([agentSkill()])).changes;
  expect(change).toMatchObject({ field: "agentSkills", before: null });
  expect(JSON.parse(change?.after ?? "null")).toMatchObject({ name: "lookup_orders", enabled: true, configRedacted: true });
});
it("reports no skill change when only write timestamps, order or config key order differ", () => {
  const notify = agentSkill({ id: "44444444-4444-4444-8444-444444444444", skillName: "notify_team", kind: "notify", config: { delivery: { recipientEmails: ["team@acme.example"] }, subject: "New lead" } });
  const rewritten = [
    { ...notify, config: { subject: "New lead", delivery: { recipientEmails: ["team@acme.example"] } }, updatedAt: new Date("2026-11-05T09:00:00.000Z") },
    agentSkill({ updatedAt: new Date("2026-11-05T09:00:00.000Z") }),
  ];
  expect(describeCandidateReleaseDiff(withAgentSkills([agentSkill(), notify]), withAgentSkills(rewritten)).changes).toEqual([]);
});
it("reports no skill change against a base that records no skills, since that base served the live skills", () =>
  expect(describeCandidateReleaseDiff(withAgentSkills(undefined), withAgentSkills([agentSkill()])).changes).toEqual([]));
it("leaves the default-answer skill out, since retrieval settings apply live", () =>
  expect(describeCandidateReleaseDiff(
    withAgentSkills([agentSkill({ skillName: "answer", kind: "retrieve", invocationMode: "default_answer", config: { sourceScope: "all" } })]),
    withAgentSkills([agentSkill({ skillName: "answer", kind: "retrieve", invocationMode: "default_answer", config: { sourceScope: { sourceIds: [] } } })]),
  ).changes).toEqual([]));

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
