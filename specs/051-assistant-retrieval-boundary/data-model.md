# Data Model: Assistant-Retrieval Boundary

## Assistant Chat Request

Represents one human-facing assistant request after transport normalization.

### Fields

- `conversationId`: existing conversation identifier, or absent for a new
  conversation
- `message`: current user message, or absent when the caller is starting a
  conversation without an initial user message
- `startConversation`: boolean for first-message or greeting-oriented starts
- `stream`: boolean indicating whether the caller expects streaming
- `userExpectedLocale`: optional locale hint for reply language selection
- `inputMetadata`: optional user-input metadata such as typed entry or
  suggestion click provenance
- `sourceContext`: normalized channel context such as `authenticated_chat`,
  `public_chat`, or `website_embed`, plus optional origin/session details
- `metadataFilter`: optional retrieval filter hints that should only be consumed
  if the assistant chooses a retrieval-backed path

### Relationships

- Produced by authenticated chat, public chat, or embed transports.
- Consumed by the assistant domain.
- May produce a downstream retrieval request when the selected route requires
  evidence.

## Assistant Route Decision

Represents the assistant-owned control-flow decision for the current turn.

### Fields

- `route`: `direct` or `retrieval`
- `reason`: `social_only`, `assistant_identity`, `evidence_required`, or other
  assistant-owned routing reason
- `conversationContextSnapshot`: derived subset of prior conversation state used
  for routing and possible downstream retrieval continuity

### Relationships

- Produced by the assistant route service.
- Controls whether retrieval runs at all for an assistant chat turn.
- Recorded into route diagnostics for later inspection.

## Assistant Chat Response

Represents the customer-facing result of one assistant chat turn.

### Fields

- `conversationId`
- `route`: object describing the selected assistant route
- `answer`
- `citations`: optional grounded citations when retrieval was used
- `answerSegments`: optional answer segmentation and citation anchors
- `suggestions`: optional follow-up suggestions
- `conversationMode`
- `conversationModeMetadata`
- `retrievalInfo`: present for route diagnostics and citation summaries
- `retrievalTrace`: optional detailed trace when enabled

### Relationships

- Returned by the assistant chat transport.
- Uses retrieval diagnostics only when the selected route is retrieval-backed.
- Shares the existing conversation/message persistence model.

## Retrieval Search Request

Represents a standalone retrieval evidence lookup.

### Fields

- `query`
- `metadataFilter`: optional retrieval filter object
- `topK`: optional result-window hint

### Relationships

- Consumed directly by retrieval search.
- Does not require assistant persona, history ownership, or social behavior.

## Retrieval Answer Request

Represents a standalone grounded answer request.

### Fields

- `query`
- `conversationContext`: optional caller-supplied continuity hints used only for
  rewrite and search
- `metadataFilter`: optional retrieval filter object

### Relationships

- Consumed directly by retrieval answer.
- May be called by headless RAG clients, MCP tools, or the assistant module.
- Does not make retrieval the canonical owner of the conversation.

## Retrieval Answer Result

Represents the success-union result returned by retrieval answer.

### Supported answer variant

- `outcome`: `answer`
- `answer`
- `citations`
- `evidence`
- `validation`
- `retrievalInfo`
- `retrievalTrace`

### Unsupported variant

- `outcome`: `unsupported`
- `code`: stable value `unsupported_query_type`
- `reason`: retrieval-scoped reason such as `social_only` or
  `assistant_identity`
- `message`: short machine-readable explanation for clients

### Relationships

- Returned by `POST /api/v1/retrieval/answer`.
- Allows retrieval clients to handle unsupported conversational asks without
  invoking assistant APIs.

## Platform Settings

Represents one shared workspace settings resource returned by
`GET /api/v1/settings`.

### Sections

- `assistant`
- `retrieval`
- `channels`

### Relationships

- Aggregates values that currently live across workspace records and retrieval
  settings records.
- Supports read and write through one platform route.
- Uses merge-safe update semantics.

## Assistant Settings Section

Represents assistant-owned behavior and identity.

### Fields

- `assistantName`
- `assistantRole`
- `greetingInstruction`
- `assistantDefaultLocale`
- `proactiveGreetingEnabled`
- `conversationMode`
- `suggestedQuestionsEnabled`
- `suggestedQuestionsCount`
- `customInstruction`
- read-only derived fields such as `assistantBootstrapActive`

### Relationships

- Backed by existing workspace columns and selected fields currently stored in
  retrieval settings.
- Consumed by assistant prompt building for both direct and retrieval-backed
  answers.

## Retrieval Settings Section

Represents retrieval-owned grounded-answer behavior.

### Fields

- `queryRewriteEnabled`
- `semanticRewriteInstructions`
- `lexicalRewriteInstructions`
- `answerSupportPolicy`
- `rerankEnabled`
- `vectorTopK`
- `similarityThreshold`
- `rerankTopK`
- `citationDisplayEnabled`
- `metadataRules`
- read-only derived fields such as `metadataFieldSuggestions`

### Relationships

- Backed by the existing retrieval settings record.
- Consumed by retrieval search and retrieval answer directly, and by
  retrieval-backed assistant turns through the retrieval port.

## Channels Settings Section

Represents public and embed access configuration that remains in scope for this
feature.

### Fields

- `anonymousChatEnabled`
- `anonymousRateLimit`
- `anonymousChatUrl`
- `websiteEmbedEnabled`
- `websiteEmbedAllowedOrigins`
- `websiteEmbedLauncherLabel`
- `websiteEmbedLauncherIcon`
- `websiteEmbedLauncherPosition`
- read-only derived fields such as `websiteEmbedScriptUrl` and
  `websiteEmbedSnippet`

### Relationships

- Backed by existing workspace fields.
- Consumed by public chat and embed transports, not by retrieval.

## Platform History Resource

Represents the shared history route family for this feature.

### Fields

- conversation summary list fields already used by dashboard history
- conversation detail fields already used by message-thread and trace views
- assistant route diagnostics on assistant messages

### Relationships

- Exposed through `GET /api/v1/history` and
  `GET /api/v1/history/:conversationId`.
- In this feature, contains assistant conversations only.
- Does not create independent history resources for retrieval-only requests.

## Route Diagnostics

Represents additive metadata that explains how a response was produced.

### Fields

- `executionSurface`: `assistant`, `retrieval`, or `mcp_capability`
- `routeType`: `direct` or `retrieval`
- `routeReason`
- `retrievalInvoked`
- `retrievalInfo`
- `retrievalTrace`

### Relationships

- Stored alongside existing audit and conversation debug metadata.
- Used by history views, troubleshooting, and contract validation.
