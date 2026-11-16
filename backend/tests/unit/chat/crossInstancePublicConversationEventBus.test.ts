import { describe, expect, it, vi } from "vitest";

import {
  CrossInstancePublicConversationEventBus,
  type PublicConversationEventRelay,
  type RelayedPublicConversationEvent,
} from "../../../src/modules/chat/services/crossInstancePublicConversationEventBus.js";
import type { PublicConversationEvent } from "../../../src/modules/chat/services/publicConversationEventBus.js";

// Delivery between real processes through Postgres is covered by
// tests/integration/public-conversation-events.integration.test.ts; these pin how the bus fans
// out, filters, and degrades against a relay the test drives.

type RelayHandlers = Parameters<PublicConversationEventRelay["subscribe"]>[0];

/** A relay that records what the bus sends and lets the test play the transport's side. */
const fakeRelay = (send: PublicConversationEventRelay["send"] = async () => undefined) => {
  const sent: RelayedPublicConversationEvent[] = [];
  const subscriptions: RelayHandlers[] = [];
  const stopped: RelayHandlers[] = [];
  const relay: PublicConversationEventRelay = {
    send: vi.fn(async (relayed: RelayedPublicConversationEvent) => {
      sent.push(relayed);
      await send(relayed);
    }),
    subscribe: vi.fn((handlers: RelayHandlers) => {
      subscriptions.push(handlers);
      return () => {
        stopped.push(handlers);
      };
    }),
  };
  const current = (): RelayHandlers => {
    const handlers = subscriptions.at(-1);
    if (!handlers || stopped.includes(handlers)) {
      throw new Error("the bus is not subscribed to the relay");
    }
    return handlers;
  };
  return { relay, sent, subscriptions, stopped, current };
};

const messageCreated = (conversationId: string, messageId = "message-1"): PublicConversationEvent => ({
  type: "message.created",
  conversationId,
  workspaceId: "workspace-1",
  messageId,
  createdAt: "2026-11-16T10:00:00.000Z",
});

const createBus = (relay: PublicConversationEventRelay, logger = { info: vi.fn(), warn: vi.fn() }) =>
  new CrossInstancePublicConversationEventBus({ instanceId: "instance-a", relay, logger });

describe("CrossInstancePublicConversationEventBus", () => {
  it("delivers an event published here to this process's subscribers at once, and sends it to the other instances", () => {
    const transport = fakeRelay();
    const bus = createBus(transport.relay);
    const listener = vi.fn();
    bus.subscribe("conversation-1", listener);

    const event = messageCreated("conversation-1");
    bus.publish(event);

    expect(listener).toHaveBeenCalledExactlyOnceWith(event);
    expect(transport.sent).toEqual([{ origin: "instance-a", event }]);
  });

  it("delivers an event another instance sent to the subscribers of its conversation only", () => {
    const transport = fakeRelay();
    const bus = createBus(transport.relay);
    const first = vi.fn();
    const second = vi.fn();
    bus.subscribe("conversation-1", first);
    bus.subscribe("conversation-2", second);

    const event = messageCreated("conversation-1");
    transport.current().event({ origin: "instance-b", event });

    expect(first).toHaveBeenCalledExactlyOnceWith(event);
    expect(second).not.toHaveBeenCalled();
    expect(transport.sent).toEqual([]);
  });

  it("ignores its own events when the relay hands them back", () => {
    const transport = fakeRelay();
    const bus = createBus(transport.relay);
    const listener = vi.fn();
    bus.subscribe("conversation-1", listener);

    const event = messageCreated("conversation-1");
    bus.publish(event);
    transport.current().event({ origin: "instance-a", event });

    expect(listener).toHaveBeenCalledOnce();
  });

  it("hears the other instances only while something in this process subscribes", () => {
    const transport = fakeRelay();
    const bus = createBus(transport.relay);

    bus.publish(messageCreated("conversation-1"));
    expect(transport.subscriptions).toHaveLength(0);
    expect(transport.sent).toHaveLength(1);

    const unsubscribeFirst = bus.subscribe("conversation-1", vi.fn());
    const unsubscribeSecond = bus.subscribe("conversation-2", vi.fn());
    expect(transport.subscriptions).toHaveLength(1);

    unsubscribeFirst();
    unsubscribeFirst();
    expect(transport.stopped).toHaveLength(0);
    unsubscribeSecond();
    expect(transport.stopped).toHaveLength(1);

    bus.subscribe("conversation-3", vi.fn());
    expect(transport.subscriptions).toHaveLength(2);
  });

  it("tells subscribers to re-read once the relay listens, and again after it reconnects", () => {
    const transport = fakeRelay();
    const logger = { info: vi.fn(), warn: vi.fn() };
    const bus = createBus(transport.relay, logger);
    const missedFirst = vi.fn();
    const missedSecond = vi.fn();
    bus.subscribe("conversation-1", vi.fn(), missedFirst);
    bus.subscribe("conversation-2", vi.fn(), missedSecond);
    bus.subscribe("conversation-3", vi.fn());

    transport.current().listening();
    expect(missedFirst).toHaveBeenCalledOnce();
    expect(missedSecond).toHaveBeenCalledOnce();
    expect(logger.info).not.toHaveBeenCalled();

    transport.current().interrupted();
    transport.current().listening();
    expect(missedFirst).toHaveBeenCalledTimes(2);
    expect(missedSecond).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledExactlyOnceWith(
      { event: "public_conversation_events_resumed", subscribers: 3 },
      expect.any(String),
    );
  });

  it("still delivers locally when the relay cannot send, and warns with ids only", async () => {
    const failure = new Error("connection refused");
    const transport = fakeRelay(async () => Promise.reject(failure));
    const logger = { info: vi.fn(), warn: vi.fn() };
    const bus = createBus(transport.relay, logger);
    const listener = vi.fn();
    bus.subscribe("conversation-1", listener);

    bus.publish(messageCreated("conversation-1"));

    expect(listener).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      { event: "public_conversation_event_relay_failed", conversationId: "conversation-1", err: failure },
      expect.any(String),
    ));
  });
});
