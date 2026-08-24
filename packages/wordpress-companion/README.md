# Radioso Sync (WordPress companion plugin)

A small WordPress plugin that pushes published, updated, and deleted content to
a Radioso workspace via a signed HTTP webhook (HMAC-SHA256). It handles any post
type, including WooCommerce products.

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

## Catalogues and custom post types

Set **Post types** to the comma-separated list you want synced — add `product`
for a WooCommerce catalogue, plus any custom types the site registers.

WordPress hands Radioso the post body, while a catalogue keeps most of what a
shopper asks about outside it. The plugin closes that gap by appending a facts
block to the content it pushes:

- Every public taxonomy term on the post, labelled with the taxonomy's own
  singular name — categories, tags, and site-specific taxonomies alike.
- On WooCommerce products: the SKU, the price, the availability WooCommerce is
  currently showing, and every visible product attribute, labelled the way the
  shop labels it (ISBN, format, page count, publisher, and so on).

Labels come from the site's own registrations, so the block arrives in the
language the site is authored in. Internal taxonomies such as WooCommerce's
visibility flags stay out of it, as do hidden product attributes.

Prices carry the shop's own tax and currency settings, and a variable product
carries the range across its variations — quoting one figure for a product that
spans several would misstate it in both directions.

### Filtering on shop values

The facts block gets the numbers into the answer; a second, machine-readable
copy gets them into retrieval. Every product also pushes a `fields` map that
Radioso stores as document metadata:

| Key | Value |
|---|---|
| `sku` | The product SKU. |
| `price` | The display price — for a variable product, the cheapest variation. |
| `price_max` | The dearest variation, when a variable product spans a range. |
| `regular_price` | The list price, before any discount. |
| `sale_price` | The discounted price, when a sale is configured. |
| `on_sale` | Whether the discount is live. Always stated, true or false. |
| `currency` | The shop currency, so a bare number can be read. |
| `stock_status` | `instock`, `outofstock` or `onbackorder`. |

In Radioso these become metadata rules on the retrieval skill: `price` less than
`20`, `on_sale` equals `true` as a boost, `stock_status` equals `instock` as a
hard filter. `stock_status` carries WooCommerce's own value rather than the
label a shopper sees, so a rule written against it survives a translation
change — the facts block still carries the wording for the agent to read out.

Keys are fixed WooCommerce vocabulary. Site-specific attributes stay in the
facts block, where their names can be anything: a rule addresses a key
literally, so a key that shifted with the shop's language would break the rule
that referenced it.

Filter `radioso_sync_product_fields` to add your own, keeping to scalar values
and keys of the form `^[A-Za-z][A-Za-z0-9_]{0,63}$`.

### Keeping price and availability current

Both move without anyone editing the post: scheduled sales, CSV imports, bulk
edits and orders all change them through the WooCommerce data store. The plugin
hooks four actions to catch every path:

- `woocommerce_update_product` — a whole-product save, from the editor, an
  import, a bulk edit or code.
- `woocommerce_product_set_stock_status` — a direct stock-status write that
  skips a full save.
- `woocommerce_updated_product_price` — a variable product's price range, which
  WooCommerce rewrites by touching `_price` directly rather than saving the
  product, so the save hook never fires for it.
- `woocommerce_update_product_variation` — a variation saved on a path that
  skips the deferred parent sync. The parent product is queued, since that is
  what Radioso holds a document for.

WooCommerce recalculates a variable price range on `shutdown` at priority 10, so
the flush runs at priority 100 — after the range settles, and late enough to pick
up anything that sync queues.

Publishes and updates are sent at the end of the request rather than the moment
a hook fires. WordPress runs `transition_post_status` from inside
`wp_insert_post()`, before the `save_post` pass where WooCommerce writes price,
stock and attributes — sending from the transition would publish the values as
they stood before the edit. Waiting also collapses the several hooks one save
trips into a single push, so the document is re-embedded once, carrying the state
the request finished with.

Deletes are sent immediately, since by the end of the request the post and its
permalink are gone. A delete cancels any update queued for the same post.

### Author taxonomy

`post_author` is the account that created the record. On a page or a post that
account is the byline, and the plugin sends it. On a catalogue it is whoever
uploaded the item, so the plugin leaves the author out rather than attributing
the catalogue to a staff login — Radioso surfaces author metadata in search and
answers.

Sites that record the real author of the work in a taxonomy — a book catalogue,
a magazine archive — set **Author taxonomy** to that taxonomy's slug (for
example `autore`). The plugin then sends those term names as the author for
every post type that has them.

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
`externalDocumentId = "wp_post_<id>"`. On a catalogue item, the document text
ends with the facts block, and `metadata.author` holds the author taxonomy terms
when that setting is filled in.

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
