import { describe, expect, it, vi } from "vitest";

import {
  UNDELIVERED_ALERT_WINDOW_MS,
  UndeliveredRecipientAlerts,
  type UndeliveredAlertClaim,
  type UndeliveredRecipientAlertStore,
} from "../../../src/modules/operatorNotifications/undeliveredRecipientAlert.js";
import type { NotificationAdministratorReader } from "../../../src/modules/operatorNotifications/notificationAdministratorReader.js";

const WORKSPACE = "00000000-0000-4000-8000-0000000000aa";
const AGENT = "00000000-0000-4000-8000-0000000000cc";
const ADDRESS = "front-desk@example.com";

/**
 * A store that throttles the way the database does: one claim per workspace and address per window.
 * It also lists the administrators, so a test reads one fake for both.
 */
const throttlingStore = (
  administrators: string[],
): UndeliveredRecipientAlertStore & NotificationAdministratorReader & { claims: number; releases: number } => {
  const lastClaimedAt = new Map<string, Date>();
  const store = {
    claims: 0,
    releases: 0,
    async claim(input: { workspaceId: string; email: string; now: Date; windowMs: number }): Promise<UndeliveredAlertClaim | null> {
      const key = `${input.workspaceId}:${input.email}`;
      const last = lastClaimedAt.get(key);
      if (last && last.getTime() > input.now.getTime() - input.windowMs) return null;
      lastClaimedAt.set(key, input.now);
      store.claims += 1;
      return { recipientId: "recipient-1", claimedAt: input.now };
    },
    async release(claim: UndeliveredAlertClaim): Promise<void> {
      store.releases += 1;
      for (const [key, at] of lastClaimedAt) if (at.getTime() === claim.claimedAt.getTime()) lastClaimedAt.delete(key);
    },
    async listAdministratorEmails(): Promise<string[]> {
      return administrators;
    },
  };
  return store;
};

const setup = (options: {
  administrators?: string[];
  dispatched?: boolean;
  /** Administrators whose mail the transport rejects. */
  rejecting?: string[];
  /** Holds every send until it resolves, so a test can decide when the mail finishes. */
  gate?: Promise<void>;
  names?: { workspaceName: string; agentName: string };
  dashboardUrl?: string | null;
} = {}) => {
  let current = new Date("2026-11-07T10:00:00.000Z");
  const store = throttlingStore(options.administrators ?? ["owner@example.com", "admin@example.com"]);
  const sent: Array<{ to: string; kind: string; subject: string; text: string; idempotencyKey: string }> = [];
  const started: string[] = [];
  const logger = { info: vi.fn(), warn: vi.fn() };
  const metrics = { incrementCounter: vi.fn() };
  const alerts = new UndeliveredRecipientAlerts({
    store,
    administrators: store,
    mailer: {
      send: async (message) => {
        started.push(message.to);
        await options.gate;
        if (options.rejecting?.includes(message.to)) throw new Error(`provider rejected ${message.to}`);
        sent.push(message);
        return { dispatched: options.dispatched ?? true };
      },
    },
    identity: { resolve: async () => options.names ?? { workspaceName: "Harbor Dental", agentName: "Front desk" } },
    dashboardUrl: async () => options.dashboardUrl === undefined ? "https://app.example.com/w/harbor/agents/agent-1" : options.dashboardUrl,
    logger,
    metrics,
    now: () => current,
  });
  return {
    alerts,
    store,
    sent,
    started,
    logger,
    metrics,
    advance: (ms: number) => { current = new Date(current.getTime() + ms); },
  };
};

const notify = (alerts: UndeliveredRecipientAlerts, reason: "unconfirmed" | "revoked" | "suppressed" = "unconfirmed") =>
  alerts.notify({ workspaceId: WORKSPACE, agentId: AGENT, email: ADDRESS, reason });

describe("UndeliveredRecipientAlerts", () => {
  it("tells every administrator which address was skipped, why, for which agent, and where to fix it", async () => {
    const { alerts, sent } = setup();

    await notify(alerts, "unconfirmed");

    expect(sent.map((message) => message.to)).toEqual(["owner@example.com", "admin@example.com"]);
    expect(sent.every((message) => message.kind === "notification_alert")).toBe(true);
    const [message] = sent;
    expect(message.subject).toContain(ADDRESS);
    expect(message.text).toContain(ADDRESS);
    expect(message.text).toContain("Front desk");
    expect(message.text).toContain("Harbor Dental");
    expect(message.text).toContain("has not confirmed");
    expect(message.text).toContain("https://app.example.com/w/harbor/agents/agent-1");
  });

  it("explains a stopped address and a bounced one differently", async () => {
    const stopped = setup();
    await notify(stopped.alerts, "revoked");
    expect(stopped.sent[0].text).toContain("stopped notifications");

    const bounced = setup();
    await notify(bounced.alerts, "suppressed");
    expect(bounced.sent[0].text).toContain("bounced or was reported as spam");
  });

  it("alerts once for an address inside a day and again once the day has passed", async () => {
    const { alerts, sent, advance } = setup({ administrators: ["owner@example.com"] });

    await notify(alerts);
    await notify(alerts);
    advance(UNDELIVERED_ALERT_WINDOW_MS - 1_000);
    await notify(alerts);
    expect(sent).toHaveLength(1);

    advance(2_000);
    await notify(alerts);
    expect(sent).toHaveLength(2);
  });

  it("throttles each address on its own", async () => {
    const { alerts, sent } = setup({ administrators: ["owner@example.com"] });

    await notify(alerts);
    await alerts.notify({ workspaceId: WORKSPACE, agentId: AGENT, email: "other@example.com", reason: "unconfirmed" });

    expect(sent).toHaveLength(2);
  });

  it("gives the claim back when there is nobody to tell, so the next skipped notice alerts again", async () => {
    const { alerts, sent, store } = setup({ administrators: [] });

    await notify(alerts);

    expect(sent).toHaveLength(0);
    expect(store.releases).toBe(1);
  });

  it("keeps the claim when the transport dispatches nothing, since retrying on every notice would send nothing either", async () => {
    const { alerts, store, metrics, logger, advance } = setup({ dispatched: false });
    const attempts = vi.spyOn(store, "listAdministratorEmails");

    await notify(alerts);
    await notify(alerts);
    await notify(alerts);

    expect(store.releases).toBe(0);
    expect(attempts).toHaveBeenCalledTimes(1);
    expect(metrics.incrementCounter).toHaveBeenCalledTimes(1);
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      "notification_undelivered_alerts_total",
      expect.objectContaining({ labels: { outcome: "not_sent", reason: "unconfirmed" } }),
    );
    expect(logger.info).not.toHaveBeenCalled();

    advance(UNDELIVERED_ALERT_WINDOW_MS + 1_000);
    await notify(alerts);
    expect(attempts).toHaveBeenCalledTimes(2);
  });

  it("counts a rejected send as a failure, once, even when another administrator was told", async () => {
    const { alerts, sent, store, metrics, logger } = setup({ rejecting: ["admin@example.com"] });

    await notify(alerts);

    expect(sent.map((message) => message.to)).toEqual(["owner@example.com"]);
    expect(metrics.incrementCounter).toHaveBeenCalledTimes(1);
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      "notification_undelivered_alerts_total",
      expect.objectContaining({ labels: { outcome: "failed", reason: "unconfirmed" } }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "notification_undelivered_alert_failed", workspaceId: WORKSPACE }),
      expect.any(String),
    );
    expect(logger.info).not.toHaveBeenCalled();
    expect(JSON.stringify([logger.warn.mock.calls, metrics.incrementCounter.mock.calls])).not.toContain("admin@example.com");
    // An administrator was told, so the day's alert stands.
    expect(store.releases).toBe(0);
  });

  it("gives the claim back when every send is rejected, so a later notice tries again", async () => {
    const { alerts, store, metrics } = setup({ rejecting: ["owner@example.com", "admin@example.com"] });

    await notify(alerts);

    expect(store.releases).toBe(1);
    expect(metrics.incrementCounter).toHaveBeenCalledTimes(1);
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      "notification_undelivered_alerts_total",
      expect.objectContaining({ labels: { outcome: "failed", reason: "unconfirmed" } }),
    );
  });

  describe("once the caller has stopped waiting", () => {
    const stopWaiting = async (options: Parameters<typeof setup>[0]) => {
      let finish!: () => void;
      const gate = new Promise<void>((resolve) => { finish = resolve; });
      const abandoned = new AbortController();
      const harness = setup({ ...options, gate });
      const running = harness.alerts.notify(
        { workspaceId: WORKSPACE, agentId: AGENT, email: ADDRESS, reason: "unconfirmed" },
        { signal: abandoned.signal },
      );
      // The mail is in flight when the caller gives up.
      await vi.waitFor(() => expect(harness.started).toHaveLength(2));
      abandoned.abort();
      finish();
      await running;
      return harness;
    };

    it("counts and logs nothing when the abandoned alert finishes late, so one alert never has two outcomes", async () => {
      const { sent, store, metrics, logger } = await stopWaiting({});

      expect(sent).toHaveLength(2);
      expect(metrics.incrementCounter).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
      // The mail went out, so the day's alert stands.
      expect(store.releases).toBe(0);
    });

    it("gives the claim back, silently, when the abandoned alert ends up sending nothing", async () => {
      const { sent, store, metrics, logger } = await stopWaiting({ rejecting: ["owner@example.com", "admin@example.com"] });

      expect(sent).toHaveLength(0);
      expect(store.releases).toBe(1);
      expect(metrics.incrementCounter).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  it("leaves the link out when the deployment has no public address", async () => {
    const { alerts, sent } = setup({ dashboardUrl: null });

    await notify(alerts);

    expect(sent[0].text).not.toContain("http");
  });

  it("bounds the tenant-authored names it prints", async () => {
    const { alerts, sent } = setup({ names: { workspaceName: "W".repeat(300), agentName: "line one\nline two" } });

    await notify(alerts);

    expect(sent[0].text).not.toContain("W".repeat(100));
    expect(sent[0].text).toContain("line one line two");
  });

  it("never rejects, and logs and counts a failure without the address", async () => {
    const { alerts, store, logger, metrics } = setup();
    store.claim = async () => { throw new Error(`database refused ${ADDRESS}`); };

    await expect(notify(alerts)).resolves.toBeUndefined();

    const warned = JSON.stringify(logger.warn.mock.calls);
    expect(warned).toContain("notification_undelivered_alert_failed");
    expect(warned).not.toContain(ADDRESS);
    expect(JSON.stringify(metrics.incrementCounter.mock.calls)).not.toContain(ADDRESS);
  });

  it("keeps the address out of its log line and metric labels when it does send", async () => {
    const { alerts, logger, metrics } = setup();

    await notify(alerts);

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "notification_undelivered_alert_sent", workspaceId: WORKSPACE, reason: "unconfirmed" }),
      expect.any(String),
    );
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(ADDRESS);
    expect(JSON.stringify(metrics.incrementCounter.mock.calls)).not.toContain(ADDRESS);
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      "notification_undelivered_alerts_total",
      expect.objectContaining({ labels: { outcome: "sent", reason: "unconfirmed" } }),
    );
  });
});
