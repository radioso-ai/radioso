import { describe, expect, it, vi } from "vitest";

import { createRoutineConsentTelemetry } from "../../../src/modules/routines/public.js";
import type { RoutineConsentWritten } from "../../../src/shared/domain/routineConsentTurn.js";
import { MetricsRegistry } from "../../../src/shared/observability/metrics/metricsRegistry.js";

const place = { workspaceId: "workspace_1", agentId: "agent_1", conversationId: "conversation_1", channel: "whatsapp" };
const consent = { routineId: "routine_class", consentKey: "health" };

const report = (written: RoutineConsentWritten[]) => {
  const logger = { info: vi.fn(), error: vi.fn() };
  const metricsRegistry = new MetricsRegistry();
  createRoutineConsentTelemetry({ logger, metricsRegistry }).committed({ ...place, written });
  const outcomes = metricsRegistry.renderPrometheus().split("\n").filter((line) => line.startsWith("radioso_routine_consent_outcomes_total{"));
  return { logger, outcomes };
};

describe("routine consent telemetry (#1544)", () => {
  it("logs and counts each consent shown, decided, defaulted to declined, and not asked", () => {
    const { logger, outcomes } = report([
      { kind: "asked", ...consent, reask: true, wordingVersionId: "version_1" },
      { kind: "decided", ...consent, decision: "granted", method: "reply", defaulted: false, wordingVersionId: "version_1", recorded: true },
      { kind: "decided", ...consent, decision: "declined", method: "reply", defaulted: true, wordingVersionId: "version_1", recorded: true },
      { kind: "skipped", ...consent, reason: "channel" },
    ]);

    expect(logger.info.mock.calls.map(([fields]) => (fields as { event: string }).event)).toEqual([
      "routine_consent_shown",
      "routine_consent_decided",
      "routine_consent_defaulted",
      "routine_consent_skipped",
    ]);
    expect(logger.info.mock.calls[0][0]).toEqual({ event: "routine_consent_shown", ...place, ...consent, wordingVersionId: "version_1", reask: true });
    expect(logger.info.mock.calls[1][0]).toMatchObject({ decision: "granted", method: "reply", recorded: true });
    expect(logger.info.mock.calls[3][0]).toMatchObject({ reason: "channel" });
    expect(outcomes).toEqual([
      'radioso_routine_consent_outcomes_total{outcome="asked"} 1',
      'radioso_routine_consent_outcomes_total{outcome="granted"} 1',
      'radioso_routine_consent_outcomes_total{outcome="defaulted"} 1',
      'radioso_routine_consent_outcomes_total{outcome="skipped"} 1',
    ]);
  });

  it("logs wording a conversation cannot show as an error, since the routine then runs without the consent's fields", () => {
    const { logger } = report([{ kind: "skipped", ...consent, reason: "wording_unavailable" }]);

    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ event: "routine_consent_skipped", reason: "wording_unavailable" }), expect.any(String));
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("logs and counts an operator's withdrawal with ids and a count alone", () => {
    const logger = { info: vi.fn(), error: vi.fn() };
    const metricsRegistry = new MetricsRegistry();

    createRoutineConsentTelemetry({ logger, metricsRegistry }).withdrawn({
      workspaceId: place.workspaceId,
      conversationId: place.conversationId,
      channel: place.channel,
      ...consent,
      wordingVersionId: "version_1",
      recordId: "record_1",
      withheldMessageCount: 2,
    });

    expect(logger.info).toHaveBeenCalledWith({
      event: "routine_consent_withdrawn",
      workspaceId: place.workspaceId,
      conversationId: place.conversationId,
      channel: place.channel,
      ...consent,
      wordingVersionId: "version_1",
      recordId: "record_1",
      withheldMessageCount: 2,
    }, expect.any(String));
    expect(metricsRegistry.renderPrometheus().split("\n").filter((line) => line.startsWith("radioso_routine_consent_outcomes_total{")))
      .toEqual(['radioso_routine_consent_outcomes_total{outcome="withdrawn"} 1']);
  });

  it("does not count a decision a retried turn had already recorded", () => {
    const { logger, outcomes } = report([
      { kind: "decided", ...consent, decision: "declined", method: "reply", defaulted: false, wordingVersionId: "version_1", recorded: false },
    ]);

    expect(outcomes).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ event: "routine_consent_decided", recorded: false }), expect.any(String));
  });
});
