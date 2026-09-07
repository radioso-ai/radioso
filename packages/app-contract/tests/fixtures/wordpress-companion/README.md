# WordPress companion vectors

Recorded deliveries from the Radioso Sync companion plugin
(`packages/wordpress-companion/radioso-sync.php`), used by
`tests/wordpressInterop.test.ts`.

Each file holds one delivery:

| Key | Meaning |
|---|---|
| `body` | The exact request body, byte for byte |
| `secret` | The shared secret the plugin was configured with |
| `signature` | `sha256=` plus the HMAC-SHA-256 of `body` under `secret` |
| `signatureHeader`, `eventHeader` | The headers `radioso_dispatch()` sends them in |
| `event` | `published`, `updated`, or `deleted` |

## How they were produced

PHP is not available in this repository's toolchain, so the bodies are written
by hand to reproduce exactly what `wp_json_encode()` emits for the array
`radioso_dispatch()` builds, and the signature is computed over those exact
bytes with `node:crypto`. That is the same order the plugin works in — encode,
then sign the encoded string — so a verifier that re-serializes before checking
the HMAC fails these vectors, which is the point of recording them.

To recompute a signature after editing a body:

```bash
node -e 'const v=require("./post-published.json");
  console.log("sha256="+require("node:crypto").createHmac("sha256",v.secret).update(Buffer.from(v.body,"utf8")).digest("hex"))'
```

The hand-written bodies reproduce four things `JSON.stringify` does not:

- `wp_json_encode()` escapes every forward slash, so URLs read `https:\/\/example.com\/`.
- It escapes non-ASCII, so a euro sign reads `\u20ac` and `è` reads `\u00e8`.
- PHP floats keep their type, so a list price of 29 euro reads `29.0`.
- `post_modified_gmt` and `post_date_gmt` are MySQL datetimes such as
  `2026-09-05 11:42:10`, not RFC 3339 instants.

## What each vector covers

| File | Covers |
|---|---|
| `post-published.json` | A post going live, with the WordPress byline author |
| `post-updated.json` | The same external id re-pushed with a later `modified_gmt` |
| `post-deleted.json` | A trashed post, which a handler turns into a delete |
| `product-default.json` | A discounted WooCommerce product under the plugin's own field map: `sale_price` beside `regular_price`, and the `<ul class="radioso-facts">` block appended to the rendered content |
| `product-filtered-isbn.json` | The same product on a shop that registers an author taxonomy and adds `ISBN` through the `radioso_sync_product_fields` filter |
