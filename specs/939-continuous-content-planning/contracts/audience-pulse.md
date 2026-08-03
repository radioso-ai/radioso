# Audience Pulse Contract Direction

## HTTP Surface

All three endpoints require the dashboard session cookie and `X-Workspace-Id`. Bearer/API
authentication receives `401` before permission, rate limiting, or service execution.
The saved-report routes require `workspace.quality.read`; the evidence helper requires
`workspace.history.read` after workspace resolution.

```text
GET  /api/v1/quality/audience-pulse
POST /api/v1/quality/audience-pulse
POST /api/v1/quality/audience-pulse/evidence-anchor
```

`GET` never calls a provider.

```ts
type AudiencePulseReadResponse =
  | { kind: "not_generated" }
  | { kind: "completed"; report: AudiencePulseHydratedReport };
```

`POST` has no body and no user-selectable period.

```ts
type AudiencePulseRefreshResponse =
  | { kind: "no_traffic"; period: Period; weeklyVolume: WeeklyVolume[] }
  | { kind: "unavailable"; reason: "provider" | "validation" | "cancelled" }
  | { kind: "completed"; report: AudiencePulseHydratedReport };
```

`POST /evidence-anchor` is a narrow, body-only history-read helper for opening a
representative source without cursor-walking a long conversation. It accepts
`{ conversationId, messageId }` in JSON, reauthorizes the exact eligible visitor
message in the selected workspace, and returns only that source plus the immediately
following assistant reply when it occurs before the next visitor turn. It calls no
provider, does not read or write a report, creates no content, and cannot retrieve an
arbitrary conversation window.

```ts
type AudiencePulseEvidenceAnchorResponse = {
  conversationId: string;
  source: {
    messageId: string;
    role: "user";
    source: "customer";
    content: string;
    createdAt: string;
  };
  nextAssistant: {
    messageId: string;
    role: "assistant";
    source: "ai_agent" | "human_agent" | "human_agent_on_behalf_of_ai_agent" | "system";
    content: string;
    createdAt: string;
  } | null;
};
```

| Status | Meaning |
|---|---|
| 401 | Invalid/missing browser dashboard session, including bearer attempts. |
| 403 | Session user lacks the route's required `workspace.quality.read` or `workspace.history.read`. |
| 404 | The evidence-anchor source is not an eligible message in the selected workspace conversation. |
| 409 | `AUDIENCE_PULSE_REFRESH_IN_PROGRESS`; dashboard presents a retry-later busy state. |
| 429 | `audience_pulse.refresh` rate limit or usage-limit capacity; dashboard presents capacity/retry-later state. |
| 503 | Workspace inference capability is unavailable before a typed refresh result can be produced. |

## Completed Report

```ts
interface AudiencePulseHydratedReport {
  period: { start: string; end: string };
  generatedAt: string;
  coverage: { populationSize: number; sampleSize: number; sampled: boolean };
  weeklyVolume: Array<{ weekStart: string; visitorQuestionCount: number; conversationCount: number }>;
  summary: string;
  themes: Array<{
    id: string;
    title: string;
    description: string;
    sampleCount: number;
    weeklyPulse: Array<{ weekStart: string; count: number }>;
    grounding: { grounded: number; degraded: number; noSupport: number; unknown: number; contentGapEligible: number };
    evidence: Array<{
      reference: string;
      conversationId: string;
      messageId: string;
      question: string;
    }>;
  }>;
  contentGaps: Array<{ themeId: string; eligibleEvidenceCount: number; distinctConversationCount: number }>;
  recommendations: Array<{
    id: string;
    themeId: string;
    title: string;
    rationale: string;
    questions: string[];
    evidenceReferences: string[];
    startDraft: { title: string; questions: string[] };
  }>;
  caveats: string[];
}
```

The stored report uses opaque source references instead of `evidence.question`. GET
reauthorizes every source in the full prompt-evidence set, then either hydrates the whole
report or conditionally invalidates its revision and returns `not_generated`. The hydrated
conversation/message IDs exist only to make an account/workspace-scoped, one-shot browser
handoff to the existing Activity drawer; they are never serialized into a URL.

## Internal Tool-shaped Port

```ts
interface AudiencePulsePort {
  read(input: { accountId: string; userId: string; workspaceId: string }): Promise<AudiencePulseReadResponse>;
  refresh(input: { accountId: string; userId: string; workspaceId: string; signal?: AbortSignal }): Promise<AudiencePulseRefreshResponse>;
}
```

The dashboard HTTP adapter is the sole v1 consumer. The Zod-backed, JSON-serializable
port supports a future read-only `audience_pulse.read` adaptation, but this feature
registers no public MCP tool, no MCP authentication path, and no content-write action.
