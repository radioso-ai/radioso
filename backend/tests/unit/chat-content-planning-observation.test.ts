import { describe, expect, it } from "vitest";

import {
  interactionFromTurnInterpretation,
  interactionWithRetrievalIntents,
  resolveConversationInteraction,
  resolveInteractionSourceUserMessageId,
} from "../../src/modules/chat/services/conversationInteraction.js";

const substantiveFollowup = interactionFromTurnInterpretation({
  interactionRole: "substantive_followup",
  rewriteProposal: {
    rewrittenQuery: "Enterprise plan pricing",
    semanticQuery: "Enterprise plan price",
    lexicalQuery: "Enterprise plan",
    turnKind: "referential_followup",
    relatedEntities: ["Enterprise plan"],
    unresolved: false,
    confidence: 0.94,
  },
});

const history = [
  { id: "user-earlier", role: "user" as const, content: "What does the Enterprise plan include?" },
  { id: "assistant-clarifier", role: "assistant" as const, content: "Which plan?" },
];

describe("neutral conversation interaction lifecycle", () => {
  it("keeps a standalone semantic intent for a substantive contextual follow-up", () => {
    expect(substantiveFollowup).toEqual({
      role: "substantive_followup",
      semanticIntents: [{ id: "primary", text: "Enterprise plan price" }],
    });
  });

  it("uses stable ordered retrieval subquery identities for a multi-intent turn", () => {
    const interaction = interactionFromTurnInterpretation({
      interactionRole: "substantive_new",
      rewriteProposal: {
        rewrittenQuery: "Compare SSO and SCIM setup",
        semanticQuery: "SSO and SCIM setup comparison",
        lexicalQuery: "SSO SCIM",
        retrievalSubqueries: [
          { id: "", label: "SSO", semanticQuery: "SSO setup", lexicalQuery: "SSO" },
          { id: "", label: "SCIM", semanticQuery: "SCIM setup", lexicalQuery: "SCIM" },
        ],
        turnKind: "comparative",
        relatedEntities: ["SSO", "SCIM"],
        unresolved: false,
        confidence: 0.91,
      },
    });

    expect(interaction.semanticIntents).toEqual([
      { id: "subquery_1", text: "SSO setup" },
      { id: "subquery_2", text: "SCIM setup" },
    ]);
  });

  it("replaces proposal intents with the exact semantic branches retrieval prepared", () => {
    expect(interactionWithRetrievalIntents(substantiveFollowup, {
      retrievalSubqueries: [
        { id: "subquery_1", semanticQuery: "Enterprise SSO requirements" },
        { id: "subquery_2", semanticQuery: "Enterprise SCIM requirements" },
      ],
      parsedQuery: { semanticQuery: "ignored combined query" },
    }).semanticIntents).toEqual([
      { id: "subquery_1", text: "Enterprise SSO requirements" },
      { id: "subquery_2", text: "Enterprise SCIM requirements" },
    ]);
  });

  it("lets lifecycle-confirmed social, routine, and pending-decision facts override inference", () => {
    expect(resolveConversationInteraction({
      inferred: substantiveFollowup,
      currentUserMessageId: "user-current",
      history,
      lifecycle: { socialTerminal: true },
    }).interaction).toEqual({ role: "social", semanticIntents: [] });

    expect(resolveConversationInteraction({
      inferred: substantiveFollowup,
      currentUserMessageId: "user-current",
      history,
      lifecycle: { routineTurn: true },
    }).interaction).toEqual({ role: "control", semanticIntents: [] });

    expect(resolveConversationInteraction({
      inferred: substantiveFollowup,
      currentUserMessageId: "user-current",
      history,
      lifecycle: { pendingDecisionTurn: true },
    }).interaction).toEqual({ role: "control", semanticIntents: [] });
  });

  it("uses a resolved clarification value to finalize the earlier source identity", () => {
    const resolved = resolveConversationInteraction({
      inferred: substantiveFollowup,
      currentUserMessageId: "user-current",
      history,
      lifecycle: { clarificationOutcome: "value" },
    });

    expect(resolved).toMatchObject({
      interaction: {
        role: "clarification_value",
        semanticIntents: [{ id: "primary", text: "Enterprise plan price" }],
      },
      sourceUserMessageId: "user-earlier",
    });
  });

  it("resolves clarification source identity by message position, never by matching text", () => {
    expect(resolveInteractionSourceUserMessageId({
      currentUserMessageId: "user-current",
      history: [
        { id: "user-duplicate-1", role: "user" },
        { id: "assistant-1", role: "assistant" },
        { id: "user-duplicate-2", role: "user" },
        { id: "assistant-2", role: "assistant" },
      ],
      useEarlierUserMessage: true,
    })).toBe("user-duplicate-2");
  });

  it.each(["declined", "expired"] as const)(
    "marks a %s clarification reply as control and expires its earlier unresolved source",
    (clarificationOutcome) => {
      expect(resolveConversationInteraction({
        inferred: substantiveFollowup,
        currentUserMessageId: "user-current",
        history,
        lifecycle: { clarificationOutcome },
        priorUnresolvedSourceUserMessageId: "user-earlier",
      })).toEqual({
        interaction: { role: "control", semanticIntents: [] },
        sourceUserMessageId: "user-earlier",
        expiresUnresolvedSourceUserMessageId: "user-earlier",
      });
    },
  );

  it("expires a prior unresolved source on the next independent resolving turn", () => {
    expect(resolveConversationInteraction({
      inferred: substantiveFollowup,
      currentUserMessageId: "user-current",
      history,
      priorUnresolvedSourceUserMessageId: "user-earlier",
      lifecycle: {},
    })).toMatchObject({
      sourceUserMessageId: "user-current",
      expiresUnresolvedSourceUserMessageId: "user-earlier",
    });
  });
});
