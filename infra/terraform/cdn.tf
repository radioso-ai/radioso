# External HTTPS load balancer + Cloud CDN for the frontend.
#
# Why: external sites that embed the widget load `/radioso-embed.js` and fetch
# `/api/embed/config/<token>` on every page view. The frontend Cloud Run service
# scales to zero, so without a cache those requests cold-start it constantly.
# Fronting the frontend with an HTTPS load balancer lets Cloud CDN serve the
# embed assets from the edge and keep that traffic off Cloud Run.
#
# Safety: the load balancer fronts the whole frontend domain, but only the two
# embed paths are routed to the CDN-enabled backend. Everything else (dashboard,
# auth, app routes) goes to a non-CDN backend and is never cached. The CDN
# backend also uses CACHE_MODE = USE_ORIGIN_HEADERS, so only responses that
# explicitly send `Cache-Control: public` are cached — the app's authenticated
# responses, which do not, are never stored even on the CDN path.
#
# Per-origin gating: `/api/embed/config/*` is reflected and gated per origin, so
# `Origin` is part of the cache key (include_http_headers). `/radioso-embed.js`
# is a classic <script> load that sends no Origin header, so it resolves to a
# single shared cache entry.
#
# Opt-in: set `frontend_cdn_domain` (e.g. "radioso.dev") to enable. Empty (the
# default) creates nothing, so existing environments are unaffected.
#
# Manual DNS cutover after `apply`:
#   1. Point the domain's A record at the `frontend_cdn_ip` output.
#   2. Remove any existing Cloud Run domain mapping for the same host first.
#   3. The Google-managed certificate only provisions once DNS resolves to that
#      IP — allow up to ~60 minutes before HTTPS works.

locals {
  frontend_cdn_enabled = var.deploy_services && var.frontend_cdn_domain != ""
}

resource "google_compute_region_network_endpoint_group" "frontend" {
  count                 = local.frontend_cdn_enabled ? 1 : 0
  name                  = "${local.resource_name_prefix}-frontend-neg"
  region                = var.region
  network_endpoint_type = "SERVERLESS"

  cloud_run {
    service = google_cloud_run_v2_service.frontend[0].name
  }
}

# Default backend: the application. CDN disabled — authenticated content is
# never cached.
resource "google_compute_backend_service" "frontend_app" {
  count                 = local.frontend_cdn_enabled ? 1 : 0
  name                  = "${local.resource_name_prefix}-frontend-app"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  enable_cdn            = false

  backend {
    group = google_compute_region_network_endpoint_group.frontend[0].id
  }
}

# CDN backend: only the embed assets are routed here (see the URL map below).
resource "google_compute_backend_service" "frontend_embed_cdn" {
  count                 = local.frontend_cdn_enabled ? 1 : 0
  name                  = "${local.resource_name_prefix}-frontend-embed-cdn"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  enable_cdn            = true

  backend {
    group = google_compute_region_network_endpoint_group.frontend[0].id
  }

  cdn_policy {
    # Cache strictly what the origin marks public. Embed config sends a short
    # public TTL on success and no-store on rejection; the app sends neither.
    cache_mode       = "USE_ORIGIN_HEADERS"
    negative_caching = false

    cache_key_policy {
      include_host         = true
      include_protocol     = true
      include_query_string = true
      # Origin is gated per allow-listed site, so it must be in the cache key.
      # NOTE: verify against current Cloud CDN docs — `include_http_headers`
      # with USE_ORIGIN_HEADERS and a `Vary: Origin` response is the supported
      # per-origin CORS caching pattern, but confirm before relying on it.
      include_http_headers = ["Origin"]
    }
  }
}

resource "google_compute_url_map" "frontend" {
  count           = local.frontend_cdn_enabled ? 1 : 0
  name            = "${local.resource_name_prefix}-frontend-lb"
  default_service = google_compute_backend_service.frontend_app[0].id

  host_rule {
    hosts        = [var.frontend_cdn_domain]
    path_matcher = "embed"
  }

  path_matcher {
    name            = "embed"
    default_service = google_compute_backend_service.frontend_app[0].id

    path_rule {
      paths   = ["/radioso-embed.js", "/api/embed/config/*"]
      service = google_compute_backend_service.frontend_embed_cdn[0].id
    }
  }
}

resource "google_compute_managed_ssl_certificate" "frontend" {
  count = local.frontend_cdn_enabled ? 1 : 0
  name  = "${local.resource_name_prefix}-frontend-cert"

  managed {
    domains = [var.frontend_cdn_domain]
  }
}

resource "google_compute_global_address" "frontend" {
  count = local.frontend_cdn_enabled ? 1 : 0
  name  = "${local.resource_name_prefix}-frontend-ip"
}

resource "google_compute_target_https_proxy" "frontend" {
  count            = local.frontend_cdn_enabled ? 1 : 0
  name             = "${local.resource_name_prefix}-frontend-https"
  url_map          = google_compute_url_map.frontend[0].id
  ssl_certificates = [google_compute_managed_ssl_certificate.frontend[0].id]
}

resource "google_compute_global_forwarding_rule" "frontend_https" {
  count                 = local.frontend_cdn_enabled ? 1 : 0
  name                  = "${local.resource_name_prefix}-frontend-https"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  target                = google_compute_target_https_proxy.frontend[0].id
  port_range            = "443"
  ip_address            = google_compute_global_address.frontend[0].id
}

# Redirect plain HTTP to HTTPS on the same address.
resource "google_compute_url_map" "frontend_http_redirect" {
  count = local.frontend_cdn_enabled ? 1 : 0
  name  = "${local.resource_name_prefix}-frontend-redirect"

  default_url_redirect {
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }
}

resource "google_compute_target_http_proxy" "frontend" {
  count   = local.frontend_cdn_enabled ? 1 : 0
  name    = "${local.resource_name_prefix}-frontend-http"
  url_map = google_compute_url_map.frontend_http_redirect[0].id
}

resource "google_compute_global_forwarding_rule" "frontend_http" {
  count                 = local.frontend_cdn_enabled ? 1 : 0
  name                  = "${local.resource_name_prefix}-frontend-http"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  target                = google_compute_target_http_proxy.frontend[0].id
  port_range            = "80"
  ip_address            = google_compute_global_address.frontend[0].id
}
