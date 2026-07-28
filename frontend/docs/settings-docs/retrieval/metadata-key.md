---
title: "Metadata Key"
description: "Reference for specifying the metadata field a retrieval filter rule should inspect."
last_updated: 2026-07-27
---

# Metadata Key

## Summary
The document metadata field this rule reads, such as `language` or `publishedAt`.

## Details
The key names which structured field on a document the rule inspects before comparing it. Common choices are `language`, `sourceUrl`, and `publishedAt`, but any field your documents carry is fair game — including tags added by metadata extraction, like `dateFrom`.

The rule is only as reliable as this field is. If the key is misspelled, or the field is filled in on some documents and blank on others, the rule matches inconsistently and its boost or filter behaves in ways that are hard to explain. Confirm the field actually exists and is populated on the documents you care about before leaning on it.
