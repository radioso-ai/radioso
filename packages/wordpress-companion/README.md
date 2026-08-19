# Radioso Sync (WordPress companion plugin)

A small WordPress plugin that pushes published, updated, and deleted pages and
posts to a Radioso workspace via a signed HTTP webhook (HMAC-SHA256).

Pairs with the `wordpress` connector in the Radioso backend
(`backend/src/modules/connectors/plugins/wordpress/`).

## Install

1. In Radioso, enable the WordPress connector in your workspace and copy:
   - The **webhook URL** shown on the connector settings page.
   - The **webhook shared secret** Radioso generated there.
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

## Resync existing content

Use **Settings → Radioso Sync → Resync all content** to backfill every existing
published post and page of the configured post types. The plugin sends each
item through the outbound signed webhook, so this works when the WordPress site
is behind Cloudflare or its REST API is blocked.

The resync runs in background batches, avoiding a timeout on large sites. It
advances as WordPress WP-Cron ticks, which normally happens with site traffic.
The settings page shows whether the next batch is scheduled, running, overdue,
or missing. It also keeps the latest 20 WordPress-side activity entries,
including schedule failures, batch checkpoints, immediate webhook-start
errors, and PHP fatal errors.

If WP-Cron is disabled or a batch is missing, overdue, stalled, or failed, use
**Run next batch now** to execute one batch from the settings page. Use
**Cancel resync** to stop an in-progress run. It is safe to run again because
Radioso upserts content by WordPress post identity.

The activity log can confirm that WordPress started a non-blocking webhook
request. It cannot confirm that Radioso accepted or ingested the post; check
the Radioso document list or backend logs for that receiver-side result.

One workspace WordPress connector accepts one site. The signed payload includes
the site's public URL, and Radioso rejects events whose site or post permalink
does not match the configured WordPress site. Changing the site URL in Radioso
rotates the shared secret, so update the plugin settings with the new secret.

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
- Check the resync status and activity log for cron, scheduling, dispatch, or
  PHP errors.
- Open **Tools → Site Health** and check for loopback-request or scheduled-event
  failures when a batch is overdue or missing.
- Check the WordPress host's PHP error log when the activity log reports a
  fatal error or a batch remains stalled.

## Security

- Payloads are signed with HMAC-SHA256 over the raw JSON body and sent in the
  `X-Radioso-Signature` header.
- The Radioso receiver uses constant-time comparison and rejects any request
  with a missing or mismatched signature.
- Requests are sent non-blocking and time out after 5 seconds so a slow
  Radioso instance never blocks a WordPress save.
