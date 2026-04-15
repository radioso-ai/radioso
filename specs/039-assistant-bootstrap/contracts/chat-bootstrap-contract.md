# Contract Notes: Assistant Bootstrap

Runtime source of truth for backend HTTP contracts remains [backend/src/app/http/openapi/document.ts](/Users/dm/conductor/workspaces/radioso/port-louis/backend/src/app/http/openapi/document.ts).

## General Settings Response

`GET /api/v1/settings/general`

Adds assistant bootstrap fields to the existing general settings payload.

### Response shape

```json
{
  "anonymousChatEnabled": false,
  "anonymousChatUrl": null,
  "anonymousRateLimit": 10,
  "assistantName": "",
  "assistantRole": "",
  "greetingInstruction": "",
  "assistantDefaultLocale": null,
  "proactiveGreetingEnabled": false
}
```

## General Settings Update

`PUT /api/v1/settings/general`

### Request additions

```json
{
  "assistantName": "Marta",
  "assistantRole": "Museum guide",
  "greetingInstruction": "Warm and concise",
  "assistantDefaultLocale": "it-IT",
  "proactiveGreetingEnabled": true
}
```

### Notes

- Existing anonymous chat fields continue to work unchanged.
- Assistant bootstrap fields are optional on update and round-trip in the response.

## Authenticated Chat Startup

`POST /api/v1/chat/`

### Request additions

```json
{
  "stream": false,
  "bootstrapGreeting": true,
  "userExpectedLocale": "it-IT"
}
```

### Behavior

- Creates a new conversation when no `conversationId` is present.
- If bootstrap is active, may persist a first assistant message before any user message.
- If bootstrap is inactive or startup generation fails, still returns a usable conversation startup result without blocking manual messaging.

## Public Chat Startup

`POST /api/v1/public/chat/{token}`

Uses the same startup additions:

```json
{
  "stream": false,
  "bootstrapGreeting": true,
  "userExpectedLocale": "en"
}
```

### Behavior

- Applies the same persona/bootstrap rules as authenticated chat.
- Respects request-scoped locale without mutating workspace identity.
- Preserves anonymous-session cookie behavior.
