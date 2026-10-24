# Lettermint provider fixtures (derived, pre-spike)

No Lettermint account existed when these were written, so none of them is a live capture. Each is
built from Lettermint's published API description and documentation:

- the generated types and operation table of the official Node SDK (`sdk/types.ts`,
  `sdk/operations.ts`, `sdk/webhook.ts`), generated from spec
  `lettermint/lettermint@a14a098fd3173b67bc366163127ee3715457cd59` (named in the first lines of
  `sdk/types.ts`);
- the example payloads in Lettermint's documentation (Webhook events, Idempotency, Team API
  reference, Inbound mail, Custom domains).

The account spike replaces every file here with a live capture, keeping the file names. Confirmed
live on 2026-10-24 with a staging project token, byte for byte: `send-mail.response.json` (202)
and `send-mail.idempotency-mismatch.json` (409, a `message` and no code). A replay under the same
key and body returned the first `message_id`.

The single-domain read `GET /domains/{id}?include=dnsRecords,projects` was confirmed live on
2026-10-24 against the team's unrestricted sender domain: a bare `DomainData` object, with no
`data` wrapper and no top-level `status`, whose `projects` is an empty array for a domain any
project may send from. `api/get-domain.dns-records.json` carries that field set and order with
test names and values, restricted to the test deployment's project. `api/update-domain-projects.response.json`
(`PUT /domains/{id}/projects`, `DomainMutationResponse`) is still derived from the SDK types.

- `api/` — Sending and Team API responses, shaped by the SDK types (`PendingSendMailResponse`,
  `MessageData`, `DomainData`, `DomainMutationResponse`, `CursorPage<DomainListData>`, `RouteData`, `CursorPage<RouteListData>`,
  `DnsVerificationFailureResponse`, `InboundDomainVerificationResponse`) and the documented error
  bodies (`send-mail.*` 409 bodies, `error.forbidden.json`, `error.rate-limited.json`,
  `create-domain.domain-taken.json`). The route fixtures carry the slug the provisioner derives for
  `mail.customer.test`.
- `api/get-message-source.inbound.eml` — the raw source of the inbound message in
  `api/get-message.inbound.json`. Its topmost `Authentication-Results` header is the one
  `lettermint.mx` adds on receipt. Below Lettermint's `Received` header sit a forged
  `Authentication-Results: lettermint.mx` header claiming every check passed and an upstream
  hop's own header, both written by the sender, so tests prove only the topmost `lettermint.mx`
  instance is read.
- `webhooks/` — the documented example of each event, with addresses moved to RFC 2606 names and
  a `kind` tag added. `message.hard_bounced.json` and `message.soft_bounced.json` carry a real
  bounce reply (the documentation's examples repeat a `250 2.0.0` acceptance) that quotes the
  recipient, so tests prove `response.content` is never kept. `message.inbound.json` uses the
  signed-URL attachment shape, the one the provisioner's routes request.
