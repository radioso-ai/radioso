---
title: "Document Types"
description: "How the workspace document type catalog decides what metadata extraction classifies documents as and which fields it pulls from each one."
last_updated: 2026-08-21
---

# Document types

## Summary
The list of document shapes extraction classifies against, and the fields to pull out of each one.

## Details
Five built-in types ship with every workspace: `Event` and `Article`, which own the date tags `dateFrom` and `dateTo`; `Profile` and `Reference`, which classify without extracting anything; and `Generic`, the fallback for a document that matches nothing else. They are read-only. Turn one off when it only produces noise for your content — `Generic` stays on, because something has to catch the rest.

Add a type of your own when your content has a shape the built-ins do not describe. A type carries a key, a label, a description of what such a page looks like, and its fields. The description is what the model classifies against, so write it as prose — "a product detail page: one purchasable item, with a price and availability" — rather than as a keyword list. Prose works in whatever language your documents are written in.

Each field declares a key, a label, a value type (`string`, `number`, `date`, or `boolean`), and an instruction saying what to pull. Extracted values land in document metadata as ordinary tags, so they show in a document's Properties panel, ride along on every chunk that document produces, and are available to per-agent metadata rules for filtering and boosting.

Field keys are shared across the workspace: two types can both declare `price`, but they have to agree it is a number, so a retrieval rule written against `price` means the same thing everywhere. A field's key and value type are fixed once saved; labels and instructions stay editable. To rename or retype a field, delete it and create a new key. Deleted keys are retired rather than forgotten — a retired key only ever comes back as its original value type.

A catalog holds up to 20 of your own types with up to 10 fields each. Descriptions run to 500 characters, field instructions to 240, labels to 80, and keys to 64. Keys start with a letter and hold letters, digits, and underscores; a dot is rejected, because rule matching reads `.` as a path separator while extracted tags are flat.

Saving replaces the whole catalog and applies to processing that happens after it. **Reprocess source** applies a new type or field to documents a source already ingested. Extraction itself runs only while metadata extraction is on.

If two people edit the catalog at once, the second save is rejected with the current revision instead of overwriting the first — reload and reapply the edit. Deleting a field that an agent's metadata rules reference warns but does not block: those rules keep working and simply stop matching, the same as any absent tag.
