# Resend provider fixtures (S0 spike, 2026-10-03)

Recorded from live probes against the Resend API and from Resend's webhook documentation.
See `specs/1403-email-channel/research.md` Part A for what each one proves.

- `api/` — real API responses. Signed download URLs are replaced with `<signed>`. One exception:
  `list-domains.json` is the recorded domain from `create-domain.receiving-eu.json` in Resend's
  documented `GET /domains` list shape (`object`, `has_more`, `data[]`, entries without `records`).
- `webhooks/` — event payloads copied from Resend's documentation; no live endpoint existed in S0.
- `get-received-email.direct.headers.eml` — raw headers of a message sent through Resend with
  `Auto-Submitted`, `In-Reply-To`, `References`, `Reply-To`, and a custom `Message-ID`, as received
  on the managed subdomain. SES replaced the `Message-ID`; every other header passed through.
