# Data Model: Chat Route Citations

## AccountRoute

- **Fields**:
  - `accountId`: authenticated account identifier used in the browser path
  - `section`: one of `chat`, `documents`, `settings`, `token`
  - `documentId?`: optional document identifier present only for an opened document route
- **Rules**:
  - The route must always resolve to the authenticated account context.
  - `documentId` is only valid when `section` is `documents`.

## ChatSession

- **Fields**:
  - `accountId`: owner of the chat session state
  - `conversationId?`: current backend conversation identifier
  - `messages[]`: ordered user and assistant messages for the current browser session
  - `isLoading`: whether a streamed or non-streamed request is active
- **Rules**:
  - Only one in-flight request may append to the active message list at a time.
  - Chat state must survive route changes within the same browser session.

## AssistantMessage

- **Fields**:
  - `id`: client-side message identifier
  - `role`: `assistant`
  - `content`: visible answer text
  - `citations[]`: ordered citation references returned with the completed answer
  - `status`: `streaming`, `complete`, or `error`
- **Rules**:
  - Streaming messages append text incrementally until the final completion event arrives.
  - Citation markers render in the citation order returned for that message.

## CitationReference

- **Fields**:
  - `index`: visible marker number
  - `documentId`: cited document identifier
  - `chunkId`: cited chunk identifier
  - `title?`: cited document title shown on hover or focus
- **Rules**:
  - The same marker number must remain stable during a single message render.
  - Activating a citation opens the matching account-scoped document route.

## DocumentSelection

- **Fields**:
  - `documentId`: selected document identifier
  - `origin`: `list` or `citation`
  - `isOpen`: whether the document detail editor or viewer is open
- **Rules**:
  - Closing the selected document clears the route back to the account-scoped documents list.
  - Document loading must still rely on the backend account authorization boundary.
