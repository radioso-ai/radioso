# WordPress companion vectors

Synthetic companion-shaped vectors used by `tests/wordpressInterop.test.ts`. Each
one is a request body in the shape `radioso_dispatch()` builds in the Radioso
Sync companion plugin, written directly as bytes and signed over those bytes.

Each file holds one delivery:

| Key | Meaning |
|---|---|
| `body` | The request body, byte for byte |
| `secret` | The shared secret the signature is computed under |
| `signature` | `sha256=` plus the HMAC-SHA-256 of `body` under `secret` |
| `signatureHeader`, `eventHeader` | The headers `radioso_dispatch()` sends them in |
| `event` | `published`, `updated`, or `deleted` |

## How they are built

PHP is not part of this repository's toolchain, so the bodies are written by hand
and the signature is computed over those exact bytes with `node:crypto`. That is
the order the plugin works in — encode, then sign the encoded string — so a
verifier that re-serializes before checking the HMAC fails these vectors, which
is what holding them as literal bytes is for.

To recompute a signature after editing a body:

```bash
node -e 'const v=require("./post-published.json");
  console.log("sha256="+require("node:crypto").createHmac("sha256",v.secret).update(Buffer.from(v.body,"utf8")).digest("hex"))'
```

## Which `wp_json_encode()` rules they reproduce

`wp_json_encode()` calls `json_encode()` with WordPress's default flags, so the
bodies follow those defaults:

- Every forward slash is escaped, so URLs read `https:\/\/example.com\/`.
- Non-ASCII is `\uXXXX`-escaped, so a euro sign reads `\u20ac` and an `e` with a
  grave accent reads `\u00e8`.
- A float whose fraction is zero is written as an integer literal. The plugin
  casts a WooCommerce list price to a PHP float and passes no
  `JSON_PRESERVE_ZERO_FRACTION`, so a 29 euro list price reads `29`, and a
  24.50 euro sale price reads `24.5`.
- `post_modified_gmt` and `post_date_gmt` are MySQL datetimes such as
  `2026-09-05 11:42:10`, not RFC 3339 instants.

Key order follows the order `radioso_dispatch()` inserts keys, because PHP
associative arrays and JSON objects both keep insertion order.

## What each vector covers

| File | Covers |
|---|---|
| `post-published.json` | A post going live, with the WordPress byline author |
| `post-updated.json` | The same external id re-pushed with a later `modified_gmt` and an unchanged `date_gmt` |
| `post-deleted.json` | The same post trashed, which a handler turns into a delete |
| `product-default.json` | A discounted WooCommerce product under the plugin's own field map: `sale_price` beside `regular_price`, and the `<ul class="radioso-facts">` block appended to the rendered content |
| `product-filtered-isbn.json` | The same product on a shop that registers an author taxonomy and adds `ISBN` through the `radioso_sync_product_fields` filter |

Post 4211 carries one `date_gmt` across all three post vectors, so the published,
updated, and deleted deliveries describe one post's life rather than three
unrelated ones.
