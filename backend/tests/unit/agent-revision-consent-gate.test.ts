import { describe, expect, it } from "vitest";

import { assertCandidateSnapshotIsRunnable, parseAgentRevisionSnapshot } from "../../src/modules/agents/public.js";

const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const italian = { locale: "it", body: "Chiediamo delle tue esigenze alimentari per preparare il pasto.", agreeLabel: "Accetto", declineLabel: "No, grazie" };

const routine = (overrides: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  agentId,
  lineageId: "22222222-2222-4222-8222-222222222222",
  version: 1,
  name: "Book a table",
  enabled: true,
  activation: { triggerDescription: "A guest wants to book a table.", gateRef: null, priority: 0, reentryMode: "once_per_conversation" },
  slots: [{ stableSlotId: "dietary", key: "dietary", type: "text", required: true, description: null, ordinal: 0, sensitivity: "sensitive" }],
  steps: [{ stableStepId: "ask_diet", kind: "chat", instruction: "Ask about {{slot.dietary}}.", toolRef: null, actionType: null, ordinal: 0, metadata: {} }],
  transitions: [{ fromStep: "ask_diet", toRef: "booked", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, ordinal: 0 }],
  terminals: [{ stableStepId: "booked", kind: "complete", instruction: "Confirm the booking.", ordinal: 0 }],
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  ...overrides,
});

const snapshot = (routines: unknown[]) => parseAgentRevisionSnapshot({ customInstruction: null, directives: [], routines, contextVariableEnablements: [] });

const refusalOf = (run: () => void): { details?: { diagnostics?: Array<Record<string, unknown>> } } => {
  try {
    run();
  } catch (error) {
    return error as { details?: { diagnostics?: Array<Record<string, unknown>> } };
  }
  throw new Error("expected the snapshot to be refused");
};

describe("the release gate and routine consents (#1544)", () => {
  it("refuses a sensitive field no consent covers, naming the field in a message safe to show", () => {
    const refusal = refusalOf(() => assertCandidateSnapshotIsRunnable(snapshot([routine()]), { agentDefaultLocale: "it" }));

    expect(refusal.details?.diagnostics).toEqual([{
      safeDiagnostic: true,
      routineId: "11111111-1111-4111-8111-111111111111",
      code: "sensitive_slot_without_consent",
      location: "slot:dietary",
      message: 'Field "dietary" is sensitive, so visitors must agree to a consent before it is collected. Add a consent that covers it.',
    }]);
  });

  it("releases the routine once a consent covers the field, and a parked routine whatever it holds", () => {
    const consent = { key: "dietary", slotKeys: ["dietary"], onDecline: "handoff", variants: [italian] };

    expect(() => assertCandidateSnapshotIsRunnable(snapshot([routine({ consents: [consent] })]), { agentDefaultLocale: "it" })).not.toThrow();
    expect(() => assertCandidateSnapshotIsRunnable(snapshot([routine({ enabled: false })]), { agentDefaultLocale: "it" })).not.toThrow();
  });

  it("asks for wording in the agent's default language as it is at publish, after that language changes", () => {
    const consent = { key: "dietary", slotKeys: ["dietary"], onDecline: "handoff", variants: [italian] };
    const refusal = refusalOf(() => assertCandidateSnapshotIsRunnable(snapshot([routine({ consents: [consent] })]), { agentDefaultLocale: "en" }));

    expect(refusal.details?.diagnostics).toEqual([expect.objectContaining({
      code: "consent_missing_default_variant",
      location: "consent:dietary.variants",
      message: "Consent \"dietary\" needs wording in the agent's default language.",
    })]);
  });
});
