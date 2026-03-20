# Research: Inference-Based Fallback Answers

## R1: Inference Prompt Design

**Decision**: Use a separate `buildInferencePrompt` method in `PromptBuilder` that omits the Retrieved Context section and citation rules, and adds an explicit instruction to answer from general knowledge with a disclaimer.

**Rationale**: The existing `build` method is tightly coupled to the retrieval context format (Result N, citation markers). A separate method is cleaner than adding conditional branches throughout the existing method, and keeps the retrieval prompt unchanged.

**Alternatives considered**:
- Passing a `mode` flag to the existing `build` method — rejected because it would add conditionals to every section of the prompt and make the method harder to reason about.
- Sending an empty contexts array and relying on prompt instructions alone — rejected because the citation formatting rules would still be injected, confusing the LLM.

## R2: Response Source Tagging

**Decision**: Add a `source: "retrieval" | "inference"` field to the chat response payload (both JSON and SSE `done` event). Default to `"retrieval"` for backward compatibility.

**Rationale**: The frontend needs a programmatic way to decide whether to show citations and the inference disclaimer. A top-level field is simpler than inferring from empty citations.

**Alternatives considered**:
- Using `retrievalInfo.fallbackApplied` — rejected because that field already has a specific meaning (attribute filter relaxation) and overloading it would be confusing.
- Adding a boolean `isInferenceAnswer` — rejected in favor of a string enum that is more extensible if future source types are added.

## R3: Settings Toggle Placement

**Decision**: Place the toggle in the "Response Style" section of the retrieval settings tab, after the citation display toggle.

**Rationale**: Inference fallback is a response behavior setting, not a retrieval tuning parameter. It fits naturally alongside warmth, citations, and custom instructions — all of which affect how answers are presented.

**Alternatives considered**:
- Placing it in "Retrieval Options" — rejected because the retrieval pipeline itself is unaffected; only the answer generation changes.
- Creating a new "Fallback Behavior" section — rejected as over-engineering for a single toggle.

## R4: Error Handling for Failed Inference Calls

**Decision**: If the LLM call for an inference answer fails, fall back to the existing static message ("I could not find relevant information in your documents.") and log the error via the existing error handling path.

**Rationale**: The user should never see an error screen for a graceful degradation feature. The static message is a safe, known-good fallback.

**Alternatives considered**:
- Retrying the LLM call — rejected because it adds latency and complexity for an edge case.
- Showing a different error message — rejected because the existing static message is accurate and user-friendly.

## R5: Conversation History in Inference Prompts

**Decision**: Include conversation history in the inference prompt, same as retrieval prompts.

**Rationale**: Without conversation history, the LLM cannot resolve follow-up questions or maintain conversational coherence. The inference prompt should feel like a natural continuation of the conversation, not a context switch.

**Alternatives considered**:
- Omitting history — rejected because it would break conversational flow (e.g., "tell me more" after an inference answer would have no context).
