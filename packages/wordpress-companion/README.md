# Radioso Sync (WordPress companion plugin)

A small WordPress plugin that pushes published, updated, and deleted pages and
posts to a Radioso workspace via a signed HTTP webhook (HMAC-SHA256).

Pairs with the `wordpress` connector in the Radioso backend
(`backend/src/modules/connectors/plugins/wordpress/`).

## Install

1. In Radioso, enable the WordPress connector in your workspace and copy:
   - The **webhook URL** shown on the connector settings page.
   - The **webhook shared secret** you entered (or generated) there.
2. Zip the contents of this directory:
   ```
   cd packages/wordpress-companion
   zip -r radioso-sync.zip radioso-sync.php README.md
   ```
3. In WordPress: Plugins → Add New → Upload Plugin → choose `radioso-sync.zip`
   → Install Now → Activate.
4. Go to **Settings → Radioso Sync** and paste the webhook URL and shared
   secret. Save.

That's it. Every time a configured post type is published, updated, or deleted,
the plugin will fire a signed webhook to Radioso.

## Polling fallback

If a customer cannot install plugins (e.g. WordPress.com plans below Business),
configure a non-zero **Polling fallback (seconds)** in the Radioso connector
settings instead. The connector will poll the WordPress REST API on that
interval using Application Password credentials.

## Verifying it works

Trigger a save on any synced post type and check Radioso's documents list.
You should see a new document with `metadata.source = "wordpress"` and
`externalDocumentId = "wp_post_<id>"`.

If nothing arrives:
- Confirm Radioso reports the connector as **enabled** for your workspace.
- Confirm the shared secret matches exactly.
- Check WordPress' PHP error log for `wp_remote_post` warnings.

## Security

- Payloads are signed with HMAC-SHA256 over the raw JSON body and sent in the
  `X-Radioso-Signature` header.
- The Radioso receiver uses constant-time comparison and rejects any request
  with a missing or mismatched signature.
- Requests are sent non-blocking and time out after 5 seconds so a slow
  Radioso instance never blocks a WordPress save.
