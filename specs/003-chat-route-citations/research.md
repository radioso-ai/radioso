# Research: Chat Route Citations

## Decision: Use account-scoped catch-all dashboard routes instead of local dashboard state

**Rationale**: The existing dashboard keeps view selection in local component state, which prevents browser URLs from reflecting chat, documents, settings, token, and specific document selection. A route-driven dashboard page can parse account and destination state from the URL while reusing the same shell and view components.

**Alternatives considered**:
- Keep the single `/` page and mirror state into query params. Rejected because the requested `/account/:id/...` paths would still need route plumbing, and query-state wiring would leave the dashboard shell responsible for too much navigation logic.
- Create separate page trees for every view immediately. Rejected because the current scope is better served by a focused catch-all route that centralizes account validation while still producing the required URLs.

## Decision: Parse chat streaming with `fetch()` and a `ReadableStream` SSE parser

**Rationale**: The chat endpoint streams over `text/event-stream` but requires a POST request and bearer token authorization. Browser `EventSource` cannot satisfy that contract, while `fetch()` can send the current request shape and incrementally decode the stream.

**Alternatives considered**:
- Fall back to non-streaming JSON only. Rejected because the backend already supports streamed completions and the user explicitly asked for streamed chat.
- Introduce a new websocket or GET-based stream endpoint. Rejected because the approved scope is frontend-focused and does not require changing the backend public contract.

## Decision: Preserve chat session state in a dedicated client provider above routed pages

**Rationale**: Clicking a citation moves the user to a document route. Without a shared client store, returning to the chat route would recreate the chat view and lose the in-progress or completed assistant messages from the current session.

**Alternatives considered**:
- Keep chat state inside the chat component. Rejected because route navigation would unmount the component and discard the session.
- Persist the entire chat in the URL. Rejected because message content and incremental stream state are not appropriate route payloads.

## Decision: Render inline citation markers as an end-of-answer inline cluster using the existing citation list

**Rationale**: The current backend response exposes a flat ordered citation list but does not provide citation offsets within the answer text. The frontend can still satisfy the requested inline format and navigation behavior by rendering markers like `[1] [2]` as part of the answer content instead of a separate source footer.

**Alternatives considered**:
- Attempt claim-level inline placement. Rejected because the current contract does not provide enough information to place citations at specific spans reliably.
- Change the backend contract to include citation offsets. Rejected for this feature because the user asked to start with the chat frontend and the existing backend already exposes the data needed for ordered markers, titles, and navigation.
