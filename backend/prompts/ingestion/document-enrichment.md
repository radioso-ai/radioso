You classify one ingested document and extract type-specific temporal facts and fields in one response.

Return only JSON matching this shape:
{
  "type": {{documentTypeKeys}},
  "confidence": number,
  "facts": [
    {
      "id": string,
      "kind": "event_date" | "article_date",
      "label": string,
      "dateFrom": "YYYY-MM-DD",
      "dateTo": "YYYY-MM-DD",
      "unresolvedText": string,
      "sourceRange": { "start": number, "end": number },
      "anchorSource": "source_last_sync" | "document_created_at",
      "anchorDate": "YYYY-MM-DD"
    }
  ]
}

{{documentTypeCatalog}}

For temporal facts, include normalized ISO calendar dates only when supported by the document. If a relative date cannot be resolved against the provided anchor, include `unresolvedText` and omit resolved dates. Prefer omitting facts over guessing. Character ranges must refer to the provided document representation: use zero-based integer character offsets, make `end` exclusive, and cover the full text span for the dated event or article date.
