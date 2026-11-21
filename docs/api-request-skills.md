---
title: "API Request Skills"
description: "Reference for API connections and api_request skills, which let a routine call a REST API and use the typed values the response returns."
last_updated: 2026-11-21
---

# API Request Skills

An API request skill lets a routine call a REST API and carry the answer on:
look up an order by its number, then tell the visitor where it is, or create a
ticket and quote its reference. The routine decides when to call. The skill
decides exactly what is sent and which parts of the response come back.

Two objects make that work. An **API connection** holds the base URL and the
credential for one API. An **API request skill** names a connection, one
request on it, the values the request takes, and the values it returns.

## 1. Create an API connection

A connection belongs to the workspace, and any agent's skills can use it. The
routes need a signed-in teammate: reads require `workspace.settings.read`,
writes require `workspace.settings.manage`, and machine credentials are
refused.

- `GET /api/v1/settings/api-connections` returns `{ connections }`
- `POST /api/v1/settings/api-connections` returns `201 { connection }`
- `GET /api/v1/settings/api-connections/{connectionId}`
- `PATCH /api/v1/settings/api-connections/{connectionId}`
- `DELETE /api/v1/settings/api-connections/{connectionId}` returns `204`
- `POST /api/v1/settings/api-connections/{connectionId}/test-request`

```json
{
  "name": "shop-api",
  "baseUrl": "https://api.shop.example/v1",
  "authScheme": "bearer",
  "credential": "sk_live_example_1234",
  "defaultHeaders": { "Accept-Language": "en" }
}
```

| Field | Meaning |
|---|---|
| `name` | Unique in the workspace, compared case-insensitively. |
| `baseUrl` | HTTPS, with a host that resolves to a public address. No credentials, query or fragment. Plain `http` to localhost is allowed in local development only. |
| `authScheme` | `none`, `bearer`, `header` or `basic`. Defaults to `none`. |
| `authHeaderName` | The header that carries the credential. Required for `header`. |
| `credential` | Write-only. A bearer token, a header value, or `username:password` for `basic`. Required unless the scheme is `none`. Stored encrypted. |
| `defaultHeaders` | Non-secret headers sent on every request. They cannot set `host`, `content-length`, `authorization`, `proxy-authorization`, `cookie`, `connection`, `keep-alive`, `transfer-encoding`, `upgrade`, `te`, `expect`, or the auth header. |

A read returns the connection as `{ id, name, baseUrl, authScheme,
authHeaderName, credentialMask, defaultHeaders, createdAt, updatedAt }`.
`credentialMask` is the last four characters of the credential behind
asterisks. For `basic` it is the username followed by `:****`, so nothing of
the password shows, not even its length. The credential itself is never
returned.

`PATCH` takes any subset of the create fields. Leave `credential` out to keep
the stored one. `authHeaderName: null` clears the header name, and switching
`authScheme` to `none` drops the credential. A stored credential is only sent
where it was entered for: a `PATCH` that changes the base URL's origin (its
scheme, host or port), the auth scheme or the auth header name must send a new
`credential` in the same request, or it is refused with `400
credential_required`.

A connection that a skill uses cannot be deleted. The route answers `409
api_connection_in_use` and names the skills.

## 2. Define an API request skill

Create the skill through the agent skills API,
`POST /api/v1/agents/{agentId}/skills`, with capability `api_request` and the
connection as the target. Skill names are unique within the agent across all
skill types.

```json
{
  "name": "order_status",
  "capability": "api_request",
  "target": { "kind": "api_connection", "id": "<connectionId>" },
  "invocationMode": "routine_named",
  "config": {
    "method": "GET",
    "path": "/orders/{order_number}",
    "exposedParams": {
      "order_number": { "type": "text", "description": "The order number" },
      "email": { "type": "email", "verifiedOnly": true }
    },
    "outputs": {
      "status": { "path": "status", "type": "text", "description": "Order status", "required": true },
      "items": {
        "path": "items",
        "type": "list",
        "description": "Items in the order",
        "maxItems": 5,
        "fields": {
          "sku": { "path": "sku", "type": "text", "role": "key" },
          "name": { "path": "name", "type": "text", "role": "title" },
          "photo": { "path": "image_url", "type": "text", "role": "image" }
        }
      }
    }
  }
}
```

The invocation mode is `routine_named`: routines run API requests. A directive
or an agent's own tool choice cannot call one.

Creating, editing, switching or deleting the skill is a draft change, like any
other skill write: Test Chat runs the draft right away, and visitors get the
change once you publish. A conversation runs the method, path, params and
outputs of the release it started on. The connection is a workspace setting, so
a new base URL or credential applies to every conversation at once.

### Config

| Key | Meaning |
|---|---|
| `method` | `GET`, `POST`, `PUT`, `PATCH` or `DELETE`. |
| `path` | Appended to the connection's base URL. Starts with one `/`, with no query or fragment. |
| `boundParams` | Fixed values, any JSON, sent as written. |
| `exposedParams` | Values the routine supplies. Each has a `type`, an optional `description`, an optional `slotBinding`, `required` (default `true`) and `verifiedOnly` (default `false`). |
| `outputs` | The values that come back, by name. |

### Where each parameter goes

There are no templates. Radioso places every parameter by its key:

- A `{key}` placeholder in the path takes that parameter, URL-encoded. The
  value is a scalar that stays within its segment: it is not empty, `.` or
  `..`, and holds no `/` or `\`, also once percent-decoded. Any other value
  settles `invalid_input` and nothing is sent.
- The remaining parameters go in the query string for `GET` and `DELETE`.
  An array repeats the key and an object is sent as JSON text.
- For `POST`, `PUT` and `PATCH` they go in a JSON body. A dotted key nests:
  `customer.email` becomes `{ "customer": { "email": "…" } }`.

Bound and exposed keys must differ, every placeholder must be a declared
parameter, and a body key cannot also be the parent of a dotted key.

### Typed inputs

Each exposed value is coerced to its type before anything is sent.

| Type | Accepts |
|---|---|
| `text` | The value as written. Numbers and booleans become text. |
| `number` | A number, or a plain decimal string such as `"12.50"`. No thousands separators. |
| `boolean` | `true` or `false`. |
| `date` | An ISO date, `YYYY-MM-DD`. A date-time is reduced to its date. |
| `email` | A trimmed, valid email address. |

A value that does not fit settles `invalid_input`, and nothing is sent. A
`text` parameter takes a slot of any type; the other types need a slot of the
matching type.

### Verified-only inputs

Set `verifiedOnly: true` on a parameter that must belong to the person asking,
such as the email on an order lookup. The value has to come from a context
variable the host application verified, meaning a signed context variable. A
value from a slot, an unverified context variable or a literal settles
`unverified`, and so does a missing one, whether or not the parameter is
`required`. Nothing is sent. This stops a visitor from typing someone else's
email address to read their orders, and an optional email filter from being
dropped from the request. A routine may bind a required parameter to a context
variable: the skill checks the value when it runs.

### Outputs

Outputs are an allowlist. Only the outputs you declare leave the skill; the raw
response never reaches the model, the routine, traces or logs.

A scalar output is `{ path, type, description?, required? }` with `type` one of
`text`, `number`, `boolean`, `date` or `email`. A list output is `{ path, type:
"list", description?, required?, maxItems, fields }`, where `maxItems` is 1 to
20 (default 10) and each field is `{ path, type, description?, role? }` with
its path relative to the item. A field has no `required`: an item that lacks
it leaves the field off that item.

- A path is dot segments. A numeric segment indexes an array
  (`items.0.title`). A path has at most 10 segments, and a key that contains
  `.` cannot be named.
- A value is coerced to its type or left out. A list keeps its first
  `maxItems` items with exactly the declared fields. An empty list counts as
  absent, so a routine guard "is set" on a list means "found any". Lists do not
  nest.
- `required` defaults to `false`. A required output the response leaves absent
  fails the skill with reason `response_mismatch`.
- Serialized outputs over 16 KB fail with `outputs_too_large`.
- Roles are `key`, `title`, `subtitle`, `image` and `link`. Each role is used at
  most once per list, and `image` and `link` fields must be `text`.

### What the agent reads

The model reads outputs as typed, described lines, for example
`status — Order status (text): "shipped"`, and lists as numbered items. When a
reply shows a list as cards, the roles decide the card's key, title, subtitle,
image and link. The model only picks which records to show.

The routine's next-step selector reads the outputs this way, and so does the
reply of every step the routine reaches on the turn the request runs, an ending
included. An output the response left out reads as not returned, and a reply
says nothing was found only when the outcome is `not_found` or a failure, or
when no declared output came back. A step on a later turn reads only the
variables the skill step set, so set each output a later step needs and name it
in that step's text, such as `@status`.

## 3. Use the skill in a routine

A routine step names the skill. The skill catalog the routine editor reads
lists each skill's declared outputs with their types and list fields, so a step
can set variables from them and a field guard can test them. A step can also
branch on the outcome. See [Authoring Routines](authoring-routines.md).

### Outcomes

| Outcome | When |
|---|---|
| `completed` | The response was 2xx. |
| `not_found` | The response was 404. |
| `rejected` | Another 4xx, except 401, 403 and 429. |
| `missing_input` | A required parameter had no value. |
| `invalid_input` | A value did not fit its type. |
| `unverified` | A `verifiedOnly` value was not from a verified context variable. |
| `failed` | Anything else, with a `reason`. |

Reasons on `failed`:

| Reason | Cause |
|---|---|
| `response_mismatch` | A required output was absent. |
| `outputs_too_large` | Outputs over 16 KB. |
| `non_json_response` | Outputs are declared and the body is not JSON. |
| `timeout` | The whole request took more than 10 seconds. |
| `network` | The connection to the API failed. |
| `upstream_error` | A 5xx, or another unexpected status. |
| `auth_rejected` | 401 or 403. |
| `rate_limited` | 429. |
| `redirect_refused` | A redirect the skill does not follow. |
| `connection_not_found` | The connection no longer exists. |
| `blocked` | The host resolved to a private address. |
| `response_too_large` | A body over 1 MB. |
| `credential_unavailable` | The stored credential could not be read. |

A skill makes one attempt and does not retry. Redirects are followed only for
`GET`, only within the same origin, up to three times.

## Test a request

`POST /api/v1/settings/api-connections/{connectionId}/test-request` sends one
real request exactly as a skill would, so a method other than `GET` acts on the
target API.

```json
{
  "method": "GET",
  "path": "/orders/{order_number}",
  "boundParams": {},
  "exposedSampleValues": { "order_number": "A-10042" },
  "outputs": { "status": { "path": "status", "type": "text", "required": true } }
}
```

The response is `{ httpStatus, durationMs, outcome, reason?, outputs,
mismatches, body, bodyTruncated }`. `body` is the parsed JSON cut to 16 KB, and
`null` when the response is empty or not JSON; read it to choose output paths.
`mismatches` lists the required outputs the response left absent.

## Test Chat and evals

In Test Chat and in eval replays, `GET` requests run for real because they only
read. Other methods are suppressed, like webhook skills.

## Worked example

A shop connection, `shop-api`, with a bearer token.

**Order status.** The `order_status` skill above looks up `GET
/orders/{order_number}`. The `email` parameter is `verifiedOnly`, so the host
passes the signed-in customer's email as a verified context variable. It lands
in the query string as `?email=…`. The routine sets `@status` from `status`,
guards on `items` being set to mean "found any", and shows `items` as cards
with `name` as the title and `photo` as the image. A step branches on
`not_found` to ask the visitor to check the number.

**Create a ticket.** A `POST` skill sends a JSON body:

```json
{
  "name": "create_ticket",
  "capability": "api_request",
  "target": { "kind": "api_connection", "id": "<connectionId>" },
  "invocationMode": "routine_named",
  "config": {
    "method": "POST",
    "path": "/tickets",
    "boundParams": { "priority": "normal" },
    "exposedParams": {
      "customer.email": { "type": "email", "verifiedOnly": true },
      "subject": { "type": "text" },
      "order_total": { "type": "number", "required": false }
    },
    "outputs": {
      "reference": { "path": "ticket.reference", "type": "text", "required": true }
    }
  }
}
```

The body is `{ "priority": "normal", "customer": { "email": "…" }, "subject":
"…" }`. The routine sets `@ticket_ref` from `reference` and quotes it to the
visitor. A response without `ticket.reference` fails with
`response_mismatch`, so the routine never quotes a reference that does not
exist.

## Limits

- Routines call API request skills. Directive and turn binding, and
  agent-selectable use, are not supported.
- A context variable cannot be resolved through an API request.
- There is no OpenAPI import. You declare each request by hand.
- Authentication covers `none`, `bearer`, `header` and `basic`. OAuth client
  credentials and API keys in the query string are not supported.
- A skill makes a single attempt, and does not retry or paginate.
- Only JSON responses are read as data.

## Observability

Each dispatch records the span `api_request.skill.dispatch` and increments
`api_request_skill_dispatch_total{outcome,reason}`. A failure logs
`api_request_skill_failed` with ids and the reason. URLs, headers, credentials,
bodies and values are never recorded.
