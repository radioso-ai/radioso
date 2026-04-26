# Assistant And Retrieval API Contract

This document defines the target request and response shapes for the assistant,
retrieval, settings, and history surfaces introduced by feature 051.

## Common Rules

- All routes use JSON unless noted otherwise.
- Authenticated workspace routes use the existing workspace session or bearer
  token model.
- Public chat and embed remain tokenized transport adapters and do not call
  these authenticated routes directly from the browser.
- `GET /api/v1/history` and `GET /api/v1/history/:conversationId` expose
  assistant conversation history only in this feature.
- `PUT /api/v1/settings` is merge-safe:
  - omitted top-level sections remain unchanged
  - omitted fields within an included section remain unchanged
  - nullable fields are cleared only when explicitly set to `null`

## `POST /api/v1/assistant/chat`

Human-facing conversational entry point for authenticated chat. Public chat and
website embed normalize into this same assistant service contract behind their
own transports.

### Request

```json
{
  "conversationId": "5cb3d804-7b31-4d7b-a909-e63e08a8a7a1",
  "message": "What courses are coming up next month?",
  "startConversation": false,
  "stream": false,
  "userExpectedLocale": "en-US",
  "inputMetadata": {
    "method": "typed"
  },
  "sourceContext": {
    "surface": "authenticated_chat",
    "sourceOrigin": null
  },
  "metadataFilter": {
    "department": "training"
  }
}
```

### Notes

- `conversationId` is optional for a new conversation.
- `message` may be omitted only when `startConversation` is `true`.
- `sourceContext` is normalized transport metadata, not a retrieval contract.
- `metadataFilter` is only forwarded if the selected route requires retrieval.

### Response

```json
{
  "conversationId": "5cb3d804-7b31-4d7b-a909-e63e08a8a7a1",
  "route": {
    "type": "retrieval",
    "reason": "evidence_required"
  },
  "answer": "The next courses are ...",
  "citations": [
    {
      "documentId": "doc_123",
      "chunkId": "chunk_456",
      "title": "Course calendar"
    }
  ],
  "answerSegments": [
    {
      "text": "The next courses are ..."
    }
  ],
  "suggestions": [],
  "conversationMode": "guided",
  "conversationModeMetadata": {
    "conversationMode": "guided",
    "brevityOverrideApplied": false,
    "expansionApplied": false,
    "expansionKind": "none",
    "suggestionCount": 0,
    "followUpQuestionApplied": false
  },
  "retrievalInfo": {
    "execution": {
      "surface": "assistant",
      "path": "assistant_retrieval",
      "retrievalInvoked": true
    },
    "candidateCounts": {
      "semantic": 4,
      "lexical": 3,
      "merged": 5,
      "final": 3
    },
    "fallbackApplied": false,
    "rerankStatus": "applied",
    "rewrite": {
      "status": "applied",
      "eligible": true,
      "ran": true,
      "materialDisagreement": false
    }
  },
  "retrievalTrace": {
    "traceId": "trace_123",
    "startedAt": "2026-04-26T10:00:00.000Z",
    "completedAt": "2026-04-26T10:00:01.000Z",
    "totalDurationMs": 1000,
    "stages": [],
    "links": []
  }
}
```

## `GET /api/v1/history`

Lists assistant conversation history for the active workspace/session scope.

### Response

```json
{
  "conversations": [
    {
      "id": "5cb3d804-7b31-4d7b-a909-e63e08a8a7a1",
      "sourceChannel": "dashboard",
      "sourceOrigin": null,
      "anonymousSessionId": null,
      "createdAt": "2026-04-26T10:00:00.000Z",
      "updatedAt": "2026-04-26T10:00:05.000Z",
      "messageCount": 2,
      "userMessageCount": 1,
      "assistantMessageCount": 1,
      "preview": "What courses are coming up next month?"
    }
  ],
  "total": 1,
  "nextCursor": null,
  "hasMore": false
}
```

## `GET /api/v1/history/:conversationId`

Returns one assistant conversation with message history and route diagnostics.

### Response

```json
{
  "conversationId": "5cb3d804-7b31-4d7b-a909-e63e08a8a7a1",
  "workspaceId": "ws_123",
  "sourceChannel": "dashboard",
  "sourceOrigin": null,
  "createdAt": "2026-04-26T10:00:00.000Z",
  "updatedAt": "2026-04-26T10:00:05.000Z",
  "messageCount": 2,
  "userMessageCount": 1,
  "assistantMessageCount": 1,
  "messagesTotal": 2,
  "messageWindowOffset": 0,
  "messageWindowLimit": 50,
  "hasOlderMessages": false,
  "nextCursor": null,
  "messages": [
    {
      "id": "msg_user_1",
      "role": "user",
      "content": "What courses are coming up next month?",
      "createdAt": "2026-04-26T10:00:00.000Z"
    },
    {
      "id": "msg_asst_1",
      "role": "assistant",
      "content": "The next courses are ...",
      "createdAt": "2026-04-26T10:00:05.000Z",
      "debug": {
        "eventStatus": "success",
        "stream": false,
        "citationCount": 1,
        "route": {
          "executionSurface": "assistant",
          "routeType": "retrieval",
          "routeReason": "evidence_required",
          "retrievalInvoked": true
        },
        "retrievalInfo": {
          "execution": {
            "surface": "assistant",
            "path": "assistant_retrieval",
            "retrievalInvoked": true
          }
        },
        "retrievalTrace": {
          "summary": {
            "execution": {
              "surface": "assistant",
              "path": "assistant_retrieval",
              "retrievalInvoked": true
            }
          }
        }
      }
    }
  ]
}
```

## `GET /api/v1/settings`

Returns one shared workspace settings resource.

### Response

```json
{
  "assistant": {
    "assistantName": "Vikram",
    "assistantRole": "Training assistant",
    "greetingInstruction": "Open warmly and briefly.",
    "assistantDefaultLocale": "en-US",
    "proactiveGreetingEnabled": true,
    "assistantBootstrapActive": true,
    "conversationMode": "guided",
    "suggestedQuestionsEnabled": true,
    "suggestedQuestionsCount": 3,
    "customInstruction": "Keep answers practical."
  },
  "retrieval": {
    "queryRewriteEnabled": true,
    "semanticRewriteInstructions": "Rewrite for semantic retrieval...",
    "lexicalRewriteInstructions": "Rewrite for lexical retrieval...",
    "answerSupportPolicy": "strict",
    "rerankEnabled": true,
    "vectorTopK": 15,
    "similarityThreshold": 0.2,
    "rerankTopK": 5,
    "citationDisplayEnabled": true,
    "metadataRules": [],
    "metadataFieldSuggestions": []
  },
  "channels": {
    "anonymousChatEnabled": true,
    "anonymousChatUrl": "https://chat.example/public/token",
    "anonymousRateLimit": 20,
    "websiteEmbedEnabled": true,
    "websiteEmbedAllowedOrigins": [
      "https://example.com"
    ],
    "websiteEmbedLauncherLabel": "Ask us",
    "websiteEmbedLauncherIcon": "chat",
    "websiteEmbedLauncherPosition": "bottom-right",
    "websiteEmbedScriptUrl": "https://chat.example/embed.js",
    "websiteEmbedSnippet": "<script ...></script>"
  }
}
```

## `PUT /api/v1/settings`

Updates one or more settings sections without resetting omitted sections.

### Request

```json
{
  "assistant": {
    "assistantName": "Nora",
    "customInstruction": "Answer plainly."
  }
}
```

### Response

- Returns the full merged settings resource in the same shape as
  `GET /api/v1/settings`.

## `POST /api/v1/retrieval/search`

Returns evidence-oriented grounded search results without assistant-owned chat
behavior.

### Request

```json
{
  "query": "next month training schedule",
  "metadataFilter": {
    "department": "training"
  }
}
```

### Response

```json
{
  "outcome": "results",
  "rewrittenQuery": {
    "semantic": "next month training schedule",
    "lexical": "training schedule next month"
  },
  "results": [
    {
      "documentId": "doc_123",
      "chunkId": "chunk_456",
      "title": "Course calendar",
      "content": "Advanced workshop ...",
      "metadata": {
        "department": "training"
      },
      "score": 0.92
    }
  ],
  "retrievalInfo": {
    "execution": {
      "surface": "retrieval",
      "path": "retrieval_search",
      "retrievalInvoked": true
    }
  },
  "retrievalTrace": {
    "summary": {
      "execution": {
        "surface": "retrieval",
        "path": "retrieval_search",
        "retrievalInvoked": true
      }
    }
  }
}
```

## `POST /api/v1/retrieval/answer`

Returns a grounded answer without assistant persona or direct-answer routing.

### Request

```json
{
  "query": "what about the advanced ones?",
  "conversationContext": {
    "previousUserMessages": [
      "What courses are available?",
      "Which ones are beginner friendly?"
    ],
    "previousAssistantMessages": [
      "Here are the available courses ...",
      "These ones are beginner friendly ..."
    ],
    "followUpToMessageId": "msg_asst_1"
  },
  "metadataFilter": {
    "department": "training"
  }
}
```

### Supported response

```json
{
  "outcome": "answer",
  "answer": "The advanced courses are ...",
  "citations": [
    {
      "documentId": "doc_123",
      "chunkId": "chunk_456",
      "title": "Course calendar"
    }
  ],
  "evidence": [
    {
      "documentId": "doc_123",
      "chunkId": "chunk_456",
      "content": "Advanced workshop ..."
    }
  ],
  "validation": {
    "status": "supported",
    "policy": "strict"
  },
  "retrievalInfo": {
    "execution": {
      "surface": "retrieval",
      "path": "retrieval_answer",
      "retrievalInvoked": true
    }
  },
  "retrievalTrace": {
    "summary": {
      "execution": {
        "surface": "retrieval",
        "path": "retrieval_answer",
        "retrievalInvoked": true
      }
    }
  }
}
```

### Unsupported response

```json
{
  "outcome": "unsupported",
  "code": "unsupported_query_type",
  "reason": "social_only",
  "message": "This request is outside retrieval scope."
}
```

## MCP Contract Notes

- MCP remains parallel to assistant by default.
- `answer_grounded` should map to `POST /api/v1/retrieval/answer`.
- MCP-originated grounded answers may mark retrieval diagnostics with
  `execution.surface = "mcp_capability"` and
  `execution.path = "mcp_grounded_answer"` for debugging.
- Retrieval settings reads and writes should map to `GET/PUT /api/v1/settings`
  using the `retrieval` section, or to a focused adapter helper that extracts
  and updates only that section.
- If an MCP tool later opts into assistant conversation behavior, that should be
  a distinct tool contract rather than the default grounded-answer path.
