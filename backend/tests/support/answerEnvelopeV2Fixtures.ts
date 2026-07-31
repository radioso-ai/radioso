import { SUGGESTIONS_SENTINEL } from "../../src/modules/chat/services/groundedAnswerEnvelope.js";

export const GROUNDED_V2_BODY =
  "The advanced workshop runs in June[[1]]. Returning students can register online[[2]][[3]].";
export const GROUNDED_V2_VISIBLE =
  "The advanced workshop runs in June. Returning students can register online.";
export const DEGRADED_V2_BODY =
  "The advanced workshop runs in June[[1]], but I can't confirm the accommodation fee[[?]].";
export const DEGRADED_V2_VISIBLE =
  "The advanced workshop runs in June, but I can't confirm the accommodation fee.";
export const NO_SUPPORT_V2_BODY =
  "I'm sorry this is weighing on you. That's outside what I can help with, but I can help with our workshop schedule and registration options.";
export const FOCUSED_NO_SUPPORT_REPLY =
  "I can't confirm that from the available information, but I can help with the workshop schedule and registration options.";

export const formatV2Envelope = (body: string, tail: unknown): string =>
  `${body}\n${SUGGESTIONS_SENTINEL}\n${JSON.stringify(tail)}`;

export const groundedV2Envelope = (): string =>
  formatV2Envelope(GROUNDED_V2_BODY, {
    v: 2,
    outcome: "answer",
    claims: [[1], [2, 3]],
    suggestions: [{ text: "What does registration require?", kind: "deeper", contextIndex: 2 }],
    grounding: "degraded",
  });

export const degradedV2Envelope = (): string =>
  formatV2Envelope(DEGRADED_V2_BODY, {
    v: 2,
    outcome: "answer",
    claims: [[1], []],
    suggestions: [{ text: "Who can attend the workshop?", kind: "deeper", contextIndex: 1 }],
    grounding: "degraded",
  });

export const OUT_OF_SCOPE_V2_BODY =
  "That's not something I can help with here, but I can help with our workshop schedule and registration options.";

export const outOfScopeV2Envelope = (): string =>
  formatV2Envelope(OUT_OF_SCOPE_V2_BODY, {
    v: 2,
    outcome: "out_of_scope",
    claims: [],
    suggestions: [],
    grounding: "degraded",
  });

export const noSupportV2Envelope = (): string =>
  formatV2Envelope(NO_SUPPORT_V2_BODY, {
    v: 2,
    outcome: "no_support",
    claims: [],
    suggestions: [],
    grounding: "degraded",
  });
