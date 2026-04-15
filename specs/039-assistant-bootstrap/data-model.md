# Data Model: Assistant Bootstrap

## Workspace Assistant Bootstrap Settings

Represents workspace-scoped operator configuration for how the assistant should introduce itself in a new conversation.

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `assistantName` | string | Optional stable assistant name shown through generated greetings |
| `assistantRole` | string | Optional short description of what the assistant is for |
| `greetingInstruction` | string | Optional short operator guidance for how the opener should feel |
| `defaultLocale` | string \| null | Optional fallback locale when no request-scoped locale hint is provided |
| `proactiveGreetingEnabled` | boolean | Whether the system should attempt to create the first assistant turn automatically |

### Validation Rules

- Text fields are trimmed before persistence.
- Empty text fields normalize to empty string rather than null.
- `defaultLocale` is optional and must be a safe locale tag when present.
- Bootstrap is considered inactive when proactive greeting is off or all identity/greeting fields are empty.

## Chat Start Request

Represents the request payload used to start or continue a conversation.

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `conversationId` | UUID \| null | Present when continuing an existing conversation |
| `query` | string \| null | User message for normal chat turns |
| `stream` | boolean | Whether the answer is returned as SSE |
| `metadataFilter` | object \| null | Existing retrieval filter payload for normal chat turns |
| `userExpectedLocale` | string \| null | Request-scoped locale hint for the new conversation or first turn |
| `bootstrapGreeting` | boolean | Signals that the request is starting a new conversation with an optional assistant-first turn |

### Validation Rules

- `userExpectedLocale` is optional and validated as a bounded locale tag.
- `bootstrapGreeting` may only create a greeting for brand-new conversations.
- Existing conversations ignore `bootstrapGreeting` and must not receive duplicate bootstrap messages.
- A request must provide either a user query or `bootstrapGreeting`; it must not be an empty no-op.

## Bootstrap Greeting Result

Represents the startup outcome for a brand-new conversation.

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `conversationId` | UUID | New conversation identifier |
| `greetingCreated` | boolean | Whether a persisted assistant greeting was generated |
| `localeUsed` | string \| null | Effective locale used for the greeting when one was created |
| `failureMode` | enum \| null | Optional internal outcome classification such as `skipped`, `invalid_locale_fallback`, or `generation_failed` |

### Lifecycle

1. New chat surface determines there is no active conversation yet.
2. Client sends startup request with optional `userExpectedLocale`.
3. System resolves effective locale using request override, workspace fallback, and safe fallback behavior.
4. If bootstrap is active, system creates conversation and assistant greeting.
5. If bootstrap is inactive or fails quietly, conversation startup still remains available for manual first user message.

## Conversation Locale Context

Represents the effective locale chosen for a new conversation startup.

### Notes

- The locale is scoped to the conversation startup path, not the workspace identity.
- The same workspace may start simultaneous conversations in different locales.
- The first release may derive the locale per request without requiring a durable conversation column, as long as request-level behavior remains correct and testable.
