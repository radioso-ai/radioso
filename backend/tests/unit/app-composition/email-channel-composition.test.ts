import { describe, expect, it, vi } from "vitest";

import { createDefaultEmailChannelDrainDispatcher } from "../../../src/app/composition/defaultComposition.js";
import { createEmailChannelComposition } from "../../../src/app/composition/emailChannel.js";
import { parseEmailChannelConfig } from "../../../src/app/config/env.js";
import { EmailPlugin } from "../../../src/modules/connectors/plugins/email/emailPlugin.js";
import { CustomerReplyDeliveryDispatcher } from "../../../src/modules/customerReplyDelivery/public.js";
import { CloudTasksEmailChannelDrainDispatcher } from "../../../src/modules/emailChannel/infra/cloudTasksEmailChannelDrainDispatcher.js";
import { EmailMailboxRepository, NoopEmailChannelDrainDispatcher } from "../../../src/modules/emailChannel/public.js";
import { LocalInboundEmailReceiver } from "../../../src/modules/mail/adapters/localInboundReceiver.js";
import { ResendInboundEmailReceiver } from "../../../src/modules/mail/adapters/resendInboundReceiver.js";
import { LocalEmailDomainProvisioner } from "../../../src/modules/mail/adapters/localDomainProvisioner.js";
import { ResendEmailDomainProvisioner } from "../../../src/modules/mail/adapters/resendDomainProvisioner.js";

const SECRET = "whsec_bG9jYWwtZGV2LXNlY3JldC0wMDAwMDAwMDAwMDA=";

const localConfig = (overrides: Record<string, string> = {}) => parseEmailChannelConfig({
  EMAIL_CHANNEL_PROVIDER: "local",
  EMAIL_CHANNEL_INBOUND_DOMAIN: "in.radioso.test",
  EMAIL_CHANNEL_WEBHOOK_SECRET: SECRET,
  ...overrides,
} as never);

const fakeDb = () => {
  const trx = { isTransaction: true };
  const execute = vi.fn(async (work: (transaction: unknown) => Promise<unknown>) => work(trx));
  return { db: { isTransaction: false, transaction: vi.fn(() => ({ execute })) }, execute };
};

const compose = (config: ReturnType<typeof parseEmailChannelConfig>) =>
  createEmailChannelComposition({
    config,
    db: fakeDb().db as never,
    drains: new NoopEmailChannelDrainDispatcher(),
    activity: { record: vi.fn() },
    conversationIngest: { ingest: vi.fn() },
    agents: { findByIdAndWorkspaceId: vi.fn(async () => null) },
    audit: { record: vi.fn() },
    metrics: null,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
  });

const workerEnv = {
  GOOGLE_CLOUD_PROJECT: "radioso-test",
  WORKER_TASKS_QUEUE_LOCATION: "europe-west1",
  WORKER_TASKS_SERVICE_URL: "https://worker.example.com",
  WORKER_TASKS_INVOKER_SERVICE_ACCOUNT: "tasks@radioso-test.iam.gserviceaccount.com",
  WORKER_TASK_AUTH_TOKEN: "0123456789abcdef0123456789abcdef",
};

describe("email channel composition", () => {
  it("is null when no email provider is configured", () => {
    expect(compose(parseEmailChannelConfig({}))).toBeNull();
  });

  it("selects the local adapters for the local provider", () => {
    const composition = compose(localConfig());

    expect(composition?.receiver).toBeInstanceOf(LocalInboundEmailReceiver);
    expect(composition?.provisioner).toBeInstanceOf(LocalEmailDomainProvisioner);
    expect(composition?.plugin).toBeInstanceOf(EmailPlugin);
    expect(composition?.plugin.getWebhookPath()).toBe("/api/connectors/email/webhook");
  });

  it("selects the Resend adapters for the resend provider", () => {
    const composition = compose(parseEmailChannelConfig({
      EMAIL_CHANNEL_PROVIDER: "resend",
      EMAIL_CHANNEL_INBOUND_DOMAIN: "in.radioso.test",
      EMAIL_CHANNEL_WEBHOOK_SECRET: SECRET,
      RESEND_CHANNEL_API_KEY: "re_test_key",
    } as never));

    expect(composition?.receiver).toBeInstanceOf(ResendInboundEmailReceiver);
    expect(composition?.provisioner).toBeInstanceOf(ResendEmailDomainProvisioner);
  });

  it("supports operator_only alone in this slice, and defaults new mailboxes to it", () => {
    const composition = compose(localConfig());

    expect(composition?.supportedModes).toEqual(["operator_only"]);
    expect(composition?.mailboxes.modes()).toEqual({ supportedModes: ["operator_only"], defaultMode: "operator_only" });
  });

  it("refuses replies on email conversations with 409 email_sending_not_available", async () => {
    const composition = compose(localConfig());
    const dispatcher = new CustomerReplyDeliveryDispatcher({ email: composition!.customerReplyDeliverer });

    await expect(dispatcher.route({
      id: "conversation-1",
      workspaceId: "workspace-1",
      sourceChannel: "email",
      channelContext: {
        provider: "email",
        mailbox: { id: "mailbox-1", address: "support@customer.test" },
        threadKey: "thread-1",
        participant: { address: "alice@example.test" },
      },
    })).rejects.toMatchObject({ statusCode: 409, code: "email_sending_not_available" });
  });

  it("follows EMAIL_CHANNEL_WORKERS_ENABLED for the worker", async () => {
    expect(compose(localConfig())?.worker.running).toBe(false);
    const enabled = compose(localConfig({ EMAIL_CHANNEL_WORKERS_ENABLED: "true" }))!;
    enabled.worker.start();
    expect(enabled.worker.running).toBe(true);
    await enabled.worker.stop();

    const disabled = compose(localConfig())!;
    disabled.worker.start();
    expect(disabled.worker.running).toBe(false);
  });

  it("binds mailbox policy changes to one transaction over the mailbox repository", async () => {
    const { db, execute } = fakeDb();
    const composition = createEmailChannelComposition({
      config: localConfig(),
      db: db as never,
      drains: new NoopEmailChannelDrainDispatcher(),
      activity: { record: vi.fn() },
      conversationIngest: { ingest: vi.fn() },
      agents: { findByIdAndWorkspaceId: vi.fn(async () => null) },
      audit: { record: vi.fn() },
      metrics: null,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    })!;

    const scope = await composition.policyChanges.run(async (unit) => unit);

    expect(execute).toHaveBeenCalledOnce();
    expect(scope.mailboxes).toBeInstanceOf(EmailMailboxRepository);
  });
});

describe("createDefaultEmailChannelDrainDispatcher", () => {
  it("pushes through Cloud Tasks when the worker dispatches by Cloud Tasks and the channel has a queue", () => {
    const dispatcher = createDefaultEmailChannelDrainDispatcher(
      { ...workerEnv, WORKER_DISPATCH_DRIVER: "cloud-tasks" },
      { taskQueueName: "email-channel" },
    );

    expect(dispatcher).toBeInstanceOf(CloudTasksEmailChannelDrainDispatcher);
  });

  it.each([
    ["no Cloud Tasks dispatch", { ...workerEnv, WORKER_DISPATCH_DRIVER: "noop" as const }, { taskQueueName: "email-channel" }],
    ["no email channel queue", { ...workerEnv, WORKER_DISPATCH_DRIVER: "cloud-tasks" as const }, { taskQueueName: undefined }],
    ["no email channel", { ...workerEnv, WORKER_DISPATCH_DRIVER: "cloud-tasks" as const }, undefined],
  ])("leaves draining to the interval loop with %s", (_label, env, channel) => {
    expect(createDefaultEmailChannelDrainDispatcher(env, channel)).toBeInstanceOf(NoopEmailChannelDrainDispatcher);
  });

  it("schedules the drain task for the requested time, on the email channel's drain route", async () => {
    const client = {
      queuePath: vi.fn((project: string, location: string, queue: string) => `projects/${project}/locations/${location}/queues/${queue}`),
      createTask: vi.fn(async (_request: unknown) => [{}]),
    };
    const dispatcher = new CloudTasksEmailChannelDrainDispatcher({
      client: client as never,
      projectId: workerEnv.GOOGLE_CLOUD_PROJECT,
      location: workerEnv.WORKER_TASKS_QUEUE_LOCATION,
      queueName: "email-channel",
      workerServiceUrl: workerEnv.WORKER_TASKS_SERVICE_URL,
      invokerServiceAccountEmail: workerEnv.WORKER_TASKS_INVOKER_SERVICE_ACCOUNT,
      workerTaskAuthToken: workerEnv.WORKER_TASK_AUTH_TOKEN,
    });
    const scheduleAt = new Date(Date.now() + 60_000);

    await dispatcher.requestDrain({ maxJobs: 5, stage: "inbound", scheduleAt });

    const [[createRequest]] = client.createTask.mock.calls as unknown as [[{
      task: { scheduleTime?: { seconds: number }; httpRequest: { url: string; body: string } };
    }]];
    expect(createRequest.task.scheduleTime?.seconds).toBe(Math.floor(scheduleAt.getTime() / 1000));
    expect(createRequest.task.httpRequest.url).toBe("https://worker.example.com/internal/tasks/email-channel/drain");
    expect(JSON.parse(Buffer.from(createRequest.task.httpRequest.body, "base64").toString("utf8"))).toEqual({ maxJobs: 5, stage: "inbound" });
  });
});
