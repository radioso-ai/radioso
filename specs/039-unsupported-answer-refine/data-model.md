# Data Model: Conversational Unsupported Answers

## Grounded Miss Response

- **Purpose**: Represents the final user-visible answer when the exact request
  could not be supported but the system still needs to respond helpfully and
  honestly.
- **Attributes**:
  - `text`: final response text delivered to the user
  - `kind`: either `unsupported_with_context` or `no_context`
  - `mentionsWorkspaceLimit`: whether the response explicitly states that the
    answer was not found in workspace material
  - `hasAdjacentSuggestion`: whether the response offers a grounded next step

## Retrieved Context Summary

- **Purpose**: Bounded summary input used by the response composer.
- **Attributes**:
  - `title`: retrieved document title
  - `contentPreview`: short bounded excerpt from retrieved content
- **Rules**:
  - Summaries come only from contexts already retrieved for the turn.
  - They must not imply support for the original unsupported claim.

## Unsupported Answer Response

- **Purpose**: Final response for fully unsupported strict-mode answers.
- **Attributes**:
  - `query`: original user question
  - `unsupportedText`: raw unsupported draft content, used only as bounded input
    to explain the miss
  - `retrievedContextSummaries`: zero or more adjacent grounded sources
- **Lifecycle**:
  1. Model draft is normalized and validated.
  2. If all substantive content is unsupported under `strict`, the composer
     creates a conversational grounded miss response.
  3. The final response is persisted and classified with the existing degraded
     unsupported outcome.

## No-Context Response

- **Purpose**: Final response for turns with no relevant retrieved material.
- **Attributes**:
  - `query`: original user question
  - `workspaceOnly`: always true
  - `suggestedNextStep`: optional conversational prompt that does not claim an
    answer
- **Lifecycle**:
  1. Retrieval returns zero contexts.
  2. The composer creates a conversational no-context response.
  3. The final response is persisted and classified as `no_context_refusal`.
