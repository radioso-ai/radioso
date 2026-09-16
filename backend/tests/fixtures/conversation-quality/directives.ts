import type { AuthoredDirective } from "../../../src/modules/agents/authoredDirectives.js";
import { CQ_AGENT_ID } from "./routines.js";

/**
 * Four seed steering directives (Parlant-style guidelines) placed on the suite agent.
 * They are unbound (no skill binding) so they steer whatever answer the turn produces
 * without needing extra skill registrations. Their effect is semantic — tone, precision,
 * empathy, helpfulness — so cases assert on them mostly via `llm_judge`, with a couple of hard
 * `answer_contains` checks on exact figures the directive should surface.
 */
const FIXED_DATE = new Date("2026-01-01T00:00:00.000Z");

const baseDirective = (
  overrides: Pick<AuthoredDirective, "name" | "condition" | "action"> & Partial<AuthoredDirective>,
): AuthoredDirective => ({
  id: `directive:${overrides.name}`,
  agentId: CQ_AGENT_ID,
  priority: null,
  requiredCapabilities: [],
  dependsOn: [],
  excludes: [],
  routes: [],
  surfaces: [],
  tags: [],
  description: null,
  binding: null,
  lifecycle: null,
  enabled: true,
  metadata: {},
  createdAt: FIXED_DATE,
  updatedAt: FIXED_DATE,
  ...overrides,
});

export const pricingPrecisionDirective = baseDirective({
  name: "pricing-precision",
  condition: { kind: "contextual", description: "the user asks about pricing, plans, or how much something costs" },
  action: "Quote the exact plan names and prices from the documentation. Never estimate, round, or invent figures; if a price is not documented, say so.",
});

export const refundEmpathyDirective = baseDirective({
  name: "refund-empathy",
  condition: { kind: "contextual", description: "the user asks about a refund or cancellation, or is upset about a charge" },
  action: "Open by acknowledging the customer's concern in a warm, empathetic tone, then state the exact refund policy and the next concrete step.",
});

export const securityPrecisionDirective = baseDirective({
  name: "security-precision",
  condition: { kind: "contextual", description: "the user asks about security, compliance, certifications, or data handling" },
  action: "Answer precisely using the documented certifications and controls. Do not overpromise or claim compliance that is not documented.",
});

/**
 * Unlike the other three (topic-gated precision/empathy rules), this one is always on and
 * pushes generally toward helpfulness and anticipating follow-up needs — the exact pressure
 * FR-022 calls out: a directive that could tempt an answer to pad a partially-covered
 * request with unsourced general knowledge instead of stating what the material doesn't
 * cover. `retrieval-partial-refund-and-fee` (cases.ts) is the case that exercises it.
 */
export const maximallyHelpfulDirective = baseDirective({
  name: "maximally-helpful",
  condition: { kind: "always" },
  action: "Be as helpful and thorough as possible. Anticipate the customer's follow-up needs and go beyond the literal question whenever it helps them.",
});

export const conversationQualityDirectives: AuthoredDirective[] = [
  pricingPrecisionDirective,
  refundEmpathyDirective,
  securityPrecisionDirective,
  maximallyHelpfulDirective,
];
