---
title: "Metadata Extraction"
description: "How metadata extraction classifies documents against your document type catalog and writes the fields you define as structured tags."
last_updated: 2026-10-21
---

# Metadata Extraction

## Summary
Understand each document's type and extract the structured tags you define for it — event dates, prices, categories — after the document is indexed, without delaying when it becomes searchable.

## Details
### Overview

Metadata extraction is disabled by default. When enabled, Radioso makes one model call for each processed document. The call does two things: it decides which document type the page is, and it extracts the fields that type declares.

What extraction looks for comes from your **document type catalog**, a workspace-level list you edit in **Knowledge → Ingestion**. A type is a short natural-language description of what that kind of page looks like, plus the fields to pull out of it. Because the description is prose rather than a keyword list, it works in any language your documents are written in.

The call reads a bounded portion of the document (up to roughly the first 48,000 characters), so very large files add a predictable, capped model cost. The call is metered like any other model usage in the workspace.

### Built-In Types

Five types ship with every workspace and cover the shapes most content falls into:

- **Event** — event announcements, anything scheduled on a date or a date range.
- **Article** — news, posts, and releases carrying a publication date.
- **Profile** — people or organizations.
- **Reference** — stable reference material.
- **Generic** — the fallback for a document that matches nothing else.

`Event` and `Article` own the date tags `dateFrom` and `dateTo`. All five are read-only: you can turn any of them off if a type only produces noise for your content, except `Generic`, which is always available as the fallback.

### Defining Your Own Types

Add a type when your content has a shape the built-ins do not describe — a product page, a course listing, a job posting. Give it a key, a label, a description of what such a page looks like, and the fields to extract.

Each field declares a key, a label, a value type (`string`, `number`, `date`, or `boolean`), and an instruction telling the model what to pull. A product type might declare `productName` (string), `price` (number), `category` (string), and `availableFrom` (date). Field keys start with a letter and contain only letters, digits, and underscores.

Extracted fields land in document metadata as ordinary tags, so they show in a document's Properties panel, ride along on every chunk that document produces, and are available to per-agent metadata rules for filtering and boosting retrieval.

Field keys are shared across the whole workspace. Two types can both declare `price`, but they must agree it is a number — that way a retrieval rule written against `price` means the same thing everywhere. A field's key and value type are fixed once you create them; labels and instructions stay editable. To rename or retype a field, delete it and create a new key. Deleted keys are retired rather than forgotten: a retired key can only ever come back with its original value type, so a saved retrieval rule is never quietly re-pointed at a different kind of field.

A catalog holds up to 20 of your own types with up to 10 fields each. Descriptions run to 500 characters, field instructions to 240, labels to 80, and keys to 64.

If two people edit the catalog at once, the second save is rejected with the current revision rather than overwriting the first. Reload and reapply the edit.

### When It Runs

Extraction runs asynchronously, after the document is already searchable. A document first goes through indexing — chunking and embedding — and becomes queryable as soon as that finishes. Extraction is then scheduled as a separate, lower-priority job that fills in the structured tags in place.

In practice this means a document does not wait for the model call to become usable. During a large import or site crawl, every document is indexed first, and extraction drains afterward at lower priority. The extracted tags reach retrieval when the extraction job completes; no re-indexing is needed.

In the document editor, the Extracted metadata panel shows no extracted tags until the extraction job finishes; once it completes, `Status` shows `applied` (or the failure reason if the model call could not produce valid tags).

A catalog edit applies to processing that happens after it. **Reprocess source** re-runs extraction over documents a source already ingested, which is how you apply a new type or a new field to existing content.

### What It Adds

For event content, extraction writes the overall event span (`dateFrom` and `dateTo`) into the document's metadata — where you can see and edit it like any other tag — and attaches date tags to the passages that state each date. The model quotes the words that state each date, and Radioso finds those words in the document, so in a weekly course list a passage holding one course carries that course's date, and a passage holding several carries the span from the earliest to the latest. A document whose dates all name one range is about one event, and every passage carries it. A date stated only in the title covers the passages no other date does. Those two apply only when every date the model returned was placed and resolved; otherwise passages without a date of their own stay undated. For articles, extraction writes the publication date into document metadata the same way.

Fields from your own types are document-level values: each one is written to the document and copied to every one of its chunks, so a filter on `category` matches the whole document. Per-passage date attribution stays specific to the built-in `Event` type.

Documents that match no type are classified `Generic` and get no fields. Profiles and reference pages are classified too, and Radioso does not invent dates when the document does not support them.

If the model returns something that does not fit — a value that is not a number where a number was declared, a key you never declared, the same key twice, a date quoting words the document does not contain — that entry is dropped on its own and counted, and the rest of the document's tags are still applied. The document's provenance records which type matched, which catalog revision the run used, which keys it generated, and how many fields and dates were dropped. It never records document content.

### Who Owns a Tag

Extraction owns exactly the tags it generated, and nothing else. A tag you typed by hand, one a connector supplied, or one a source's document tags set wins: extraction skips it and counts the collision instead of overwriting the value. A tag left empty counts as unset, so extraction can fill it in.

Editing a generated tag by hand hands you ownership of it permanently. From that point extraction leaves the key alone — it neither overwrites nor removes it — so a hand-corrected price stays corrected through every later run.

A successful run replaces the previous run's generated tags in one step: the old keys come off, the new ones go on. That is how a field you delete from a type disappears from your documents on their next reprocess. A run that fails leaves every existing tag on the document standing and records only the failure, so a bad model call never costs you the tags you already had. When the content changed, the document's new passages wait for a run that succeeds before they carry generated tags again. A document that processes again with extraction off loses its generated tags, because nothing will refresh them against the new content; the tags you or a connector wrote stay.

The built-in `dateFrom` and `dateTo` tags follow the same rule, as a pair. Dates you type, send through the API, or set in a source's document tags stay on every passage through each reprocess and every run, whatever the model reads, and the run counts each date it would have written as a collision. Dates extraction wrote are extraction's to refresh; change either one by hand and both become yours.

Dates a connector syncs are defaults: WordPress writes each post's publish day as `dateFrom`, and a run that reads the event's own dates replaces it. The publish day stays when extraction is off, fails, or reads no dates. A date you edit by hand on a synced document lasts until the connector's next sync or the next run that reads dates.

### Control Levels

The workspace setting is the default for new processing jobs. Every source can follow that default, force extraction on, or force it off: open **Knowledge → Sources**, expand the source, and choose **Settings**. **Reprocess source**, next to it, applies the new choice to the documents that source already ingested.

Documents you add by hand are grouped under **Manually added documents**, which offers the same three-way choice and the same **Reprocess source** button. The choice you make there covers every document in the workspace that arrived without a source.

A reprocess request can also force extraction on or off for that run only, and the same one-run choice is available when adding a document or importing a file.

### Operational Behavior

Extraction adds model cost, so enable it where the extracted tags earn their keep in retrieval. Because it runs after indexing, it does not add latency to when a document becomes searchable. When a reply comes back empty, cut off, or out of shape, or the provider fails in a way that might clear, extraction asks once more before giving up, and both calls are metered. If extraction fails, the document stays searchable with its existing tags and records safe provenance for operators — a failed extraction never takes a document out of service.

Deleting a field or turning off a type that an agent's metadata rules reference does not block the save. Rules pointing at keys that stop being generated simply stop matching, the same as any absent tag.
