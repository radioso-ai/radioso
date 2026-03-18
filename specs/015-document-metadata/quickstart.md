# Quickstart: Document Metadata

## Prerequisites

- hivec backend running with migration 006 applied
- Valid workspace API token

## 1. Upload a document with metadata

```bash
curl -X POST http://localhost:8080/api/v1/document/ \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Product Guide",
    "content": "This guide covers the setup process for our widget platform...",
    "metadata": {
      "sourceUrl": "https://docs.example.com/guide",
      "language": "en",
      "category": "onboarding"
    }
  }'
```

Expected: `202 { "documentId": "...", "status": "queued" }`

## 2. Verify metadata is stored

```bash
curl http://localhost:8080/api/v1/document/$DOCUMENT_ID \
  -H "Authorization: Bearer $API_TOKEN"
```

Expected: response includes `"metadata": { "sourceUrl": "...", "language": "en", "category": "onboarding" }`

## 3. Upload a second document with different metadata

```bash
curl -X POST http://localhost:8080/api/v1/document/ \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Guía del producto",
    "content": "Esta guía cubre el proceso de configuración...",
    "metadata": {
      "sourceUrl": "https://docs.example.com/guia",
      "language": "es"
    }
  }'
```

## 4. Ask a question — metadata appears in retrieval context

```bash
curl -X POST http://localhost:8080/api/v1/chat/ \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "message": "How do I set up the widget?" }'
```

Expected: the LLM response can reference the source URL from the chunk metadata.

## 5. Ask with metadata filter (P2)

```bash
curl -X POST http://localhost:8080/api/v1/chat/ \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "How do I set up the widget?",
    "metadataFilter": { "language": "en" }
  }'
```

Expected: only chunks from English documents are considered — the Spanish guide is excluded.

## Verification

1. Document GET returns metadata intact
2. Chat response cites sourceUrl when available
3. Metadata filter restricts retrieval to matching documents only
4. Documents uploaded without metadata work identically to before
