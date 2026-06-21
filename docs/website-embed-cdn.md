---
title: "Website embed assets on Cloud CDN"
description: "Architecture for caching embed launcher and config on Cloud CDN to avoid cold-starting the frontend on every page view."
last_updated: 2026-06-06
---

# Website embed assets on Cloud CDN

## What this is

The website embed widget loads two things from the Radioso frontend on every
page that hosts it:

- `/radioso-embed.js` — the launcher script.
- `/api/embed/config/<token>` — the per-agent embed config (theme, copy, labels).

Both are fetched on page load, before the visitor opens the chat. The frontend
runs on Cloud Run and scales to zero, so without a cache these requests cold-start
it on every external page view.

This setup puts those two paths behind an external HTTPS load balancer with
Cloud CDN, so the edge serves them and the traffic stays off Cloud Run. It is
opt-in and off by default.

## Architecture

```
Browser on an embedding site
        |
        v
External HTTPS load balancer  (global IP, managed TLS for the frontend domain)
        |
        |-- /radioso-embed.js          --> CDN backend  (cached)
        |-- /api/embed/config/*         --> CDN backend  (cached, per origin)
        |-- everything else             --> app backend  (never cached)
        |
        v
Serverless NEG --> frontend Cloud Run
```

Key points:

- One load balancer fronts the whole frontend domain, but only the two embed
  paths route to a CDN-enabled backend. Every other path — dashboard, auth, app
  routes — goes to a separate backend with the CDN disabled.
- The CDN backend uses `CACHE_MODE = USE_ORIGIN_HEADERS`. It caches only
  responses that send `Cache-Control: public`. The embed config sends that on
  success and `no-store` on rejection; the app sends neither. So authenticated
  responses are never cached, even on the CDN path.

## Per-origin caching

The embed config is gated: the backend only returns it to origins admitted by
the website embed origin setting and reflects the request origin back in the
CORS headers. An explicit list admits only listed origins. A `*` entry admits
any origin. An empty list admits no origins.
The response therefore varies by origin and declares `Vary: Origin`.

To cache a response that varies by origin, Cloud CDN must include `Origin` in the
cache key. The CDN backend sets `cache_key_policy.include_http_headers = ["Origin"]`,
so the config is cached per `(token, origin)`. A rejected origin gets `no-store`
and is never cached, so it cannot pollute the cache.

`/radioso-embed.js` is a classic `<script>` load that sends no `Origin` header,
so it resolves to a single shared cache entry.

> Caveat to confirm against the
> [Cloud CDN cache key docs](https://cloud.google.com/cdn/docs/using-cache-keys):
> a response is only cacheable when every value in its `Vary` header is part of
> the cache key. Our `Vary: Origin` plus `include_http_headers = ["Origin"]`
> satisfies this, and `include_http_headers` requires a cache mode other than
> `CACHE_ALL_STATIC` (we use `USE_ORIGIN_HEADERS`). Verify the exact wording
> before relying on it in production.

## Cache invalidation on settings change

Cached config would otherwise go stale until its TTL expires after an operator
edits embed settings. To avoid that, the backend invalidates the cached config
path when an agent's settings change.

- When `RADIOSO_CDN_URL_MAP` and `GOOGLE_CLOUD_PROJECT` are set, the agent
  service calls the Compute Engine `urlMaps.invalidateCache` API for
  `/api/embed/config/<token>` after a successful update.
- The call is best effort: it never blocks or fails the settings save. A CDN
  hiccup just means the change waits for the TTL instead.
- When the variables are unset (local, tests, no-CDN deployments), the
  invalidator is a no-op.

The backend service account needs permission to invalidate the URL map
(`compute.urlMaps.invalidateCache`, included in roles such as
`roles/compute.loadBalancerAdmin`).

## Enabling it

1. Set the Terraform variable `frontend_cdn_domain` (for example `radioso.dev`)
   for the environment. Leaving it empty creates no load balancer or CDN.
2. Set the backend env var `RADIOSO_CDN_URL_MAP` to the URL map name
   (`<service>-<environment>-frontend-lb`) so settings changes invalidate the
   cache. `GOOGLE_CLOUD_PROJECT` must also be set.
3. `terraform apply`. This creates the global IP, managed certificate, load
   balancer, and the two backends.
4. Point the frontend domain's DNS `A` record at the `frontend_cdn_ip` output.
   Remove any existing Cloud Run domain mapping for that host first.
5. Wait for the managed certificate to provision. It only starts once DNS
   resolves to the load balancer IP, and can take up to about an hour.

## What to verify

- `terraform init && terraform validate` before applying. The CDN resources use
  the `google` provider.
- Confirm the `include_http_headers` / `Vary: Origin` behavior in the current
  Cloud CDN docs (see the caveat above).
- After cutover, check that `/radioso-embed.js` and `/api/embed/config/<token>`
  return `Cache-Control: public` and are served from the edge, while a dashboard
  route returns no cache headers.
- Edit embed settings and confirm the change appears without waiting for the TTL
  (invalidation works).

## Related

- Widget behavior and the embed contract: `docs-portal/content/quickstarts/website-embed.mdx`.
- Terraform: `infra/terraform/cdn.tf`.
