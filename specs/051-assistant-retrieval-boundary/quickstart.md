# Quickstart: Assistant-Retrieval Boundary

Use these scenarios to validate the feature after implementation.

## 1. Assistant direct answer skips retrieval

1. Open authenticated chat in a workspace with assistant identity configured.
2. Send `Who are you?`
3. Confirm the request flows through `POST /api/v1/assistant/chat`.
4. Confirm the response returns a direct assistant answer without grounded-miss
   behavior.
5. Confirm route diagnostics show `route.type = direct`.

## 2. Assistant retrieval-backed answer still grounds normally

1. Upload content that can answer a concrete question.
2. Send `What courses are coming up next month?`
3. Confirm the request flows through `POST /api/v1/assistant/chat`.
4. Confirm the assistant invokes retrieval and returns grounded citations.
5. Confirm route diagnostics show `route.type = retrieval`.

## 3. Public chat and embed still use the assistant core

1. Start one conversation through public chat and another through website
   embed.
2. Send comparable grounded questions through both transports.
3. Confirm both transports preserve their own session and origin rules.
4. Confirm both normalize into the same assistant behavior and response shape.

## 4. Shared settings updates do not reset untouched sections

1. Read `GET /api/v1/settings` and capture the current `assistant`,
   `retrieval`, and `channels` sections.
2. Send `PUT /api/v1/settings` with only an `assistant` payload that changes the
   assistant name.
3. Confirm the response shows the updated assistant name.
4. Confirm the `retrieval` and `channels` sections remain unchanged.

## 5. Retrieval answer handles follow-up rewrite without assistant ownership

1. Call `POST /api/v1/retrieval/answer` with a grounded question and capture the
   result.
2. Call it again with `what about the advanced ones?` plus
   `conversationContext`.
3. Confirm retrieval uses the supplied context for rewrite continuity.
4. Confirm the response remains a retrieval-owned grounded answer and does not
   include assistant persona behavior.

## 6. Retrieval answer returns a typed unsupported result

1. Call `POST /api/v1/retrieval/answer` with `thanks`.
2. Confirm the HTTP request succeeds with a typed response body.
3. Confirm the body returns `outcome = unsupported` and
   `code = unsupported_query_type`.
4. Confirm the response does not fabricate assistant-style social behavior.

## 7. MCP grounded answer bypasses assistant by default

1. Use the MCP package against a workspace with valid retrieval content.
2. Trigger the grounded-answer tool.
3. Confirm the adapter calls `POST /api/v1/retrieval/answer`, not
   `POST /api/v1/assistant/chat`.
4. Confirm other MCP capability reads and writes still use the platform and
   document endpoints directly.

## 8. Shared history remains assistant-conversation history only

1. Generate at least one authenticated assistant conversation.
2. Generate at least one retrieval-only answer request.
3. Call `GET /api/v1/history`.
4. Confirm assistant conversations appear.
5. Confirm retrieval-only requests do not create standalone history entries.
