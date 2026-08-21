import { z } from "zod";

export const workspacePushChangeKinds = [
  "document.status_changed",
  "crawl.status_changed",
  "crawl.progress",
  "conversation.created",
  "conversation.updated",
  "conversation.ownership_changed",
  "conversation.contact_delivery_changed",
  "hitl.decision_created",
  "hitl.decision_resolved",
  "quality.feedback_changed",
  "quality.triage_changed",
  "search.created",
] as const;

export const pushEventSchema = z.object({
  resourceType: z.string().min(1),
  resourceId: z.string().min(1),
  workspaceId: z.string().min(1),
  changeKind: z.enum(workspacePushChangeKinds),
  version: z.number().int().nonnegative(),
}).strict();

export type PushEvent = z.infer<typeof pushEventSchema>;
export type WorkspaceEventPublish = Omit<PushEvent, "version">;

export interface WorkspaceEventBus {
  publish(event: WorkspaceEventPublish): Promise<void>;
  subscribe(workspaceId: string): AsyncIterable<PushEvent>;
  /**
   * Resolves once the transport can deliver events to subscribers. A caller
   * that signals "refetch now" (the SSE ready frame) awaits this first — with
   * a cap — so the refetch lands after the point where events stop being lost.
   */
  ready(): Promise<void>;
  close(): Promise<void>;
}

interface Subscriber {
  workspaceId: string;
  queue: PushEvent[];
  resolve?: (result: IteratorResult<PushEvent>) => void;
  closed: boolean;
}

export class InMemoryWorkspaceEventBus implements WorkspaceEventBus {
  #nextVersion = 1;
  readonly #subscribers = new Set<Subscriber>();

  async ready(): Promise<void> {}

  async publish(event: WorkspaceEventPublish): Promise<void> {
    const frame = pushEventSchema.parse({ ...event, version: this.#nextVersion++ });
    for (const subscriber of this.#subscribers) {
      if (subscriber.workspaceId !== frame.workspaceId || subscriber.closed) {
        continue;
      }

      if (subscriber.resolve) {
        const resolve = subscriber.resolve;
        subscriber.resolve = undefined;
        resolve({ done: false, value: frame });
      } else {
        subscriber.queue.push(frame);
      }
    }
  }

  subscribe(workspaceId: string): AsyncIterable<PushEvent> {
    const subscriber: Subscriber = { workspaceId, queue: [], closed: false };
    this.#subscribers.add(subscriber);

    const close = () => {
      if (subscriber.closed) {
        return;
      }
      subscriber.closed = true;
      this.#subscribers.delete(subscriber);
      subscriber.resolve?.({ done: true, value: undefined });
      subscriber.resolve = undefined;
    };

    return {
      [Symbol.asyncIterator](): AsyncIterator<PushEvent> {
        return {
          next: async () => {
            if (subscriber.closed) {
              return { done: true, value: undefined };
            }
            const next = subscriber.queue.shift();
            if (next) {
              return { done: false, value: next };
            }
            return new Promise<IteratorResult<PushEvent>>((resolve) => {
              subscriber.resolve = resolve;
            });
          },
          return: async () => {
            close();
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  async close(): Promise<void> {
    for (const subscriber of [...this.#subscribers]) {
      subscriber.closed = true;
      subscriber.resolve?.({ done: true, value: undefined });
      subscriber.resolve = undefined;
      this.#subscribers.delete(subscriber);
    }
  }
}

export class NoopWorkspaceEventBus implements WorkspaceEventBus {
  async ready(): Promise<void> {}

  async publish(_event: WorkspaceEventPublish): Promise<void> {}

  subscribe(_workspaceId: string): AsyncIterable<PushEvent> {
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<PushEvent> {},
    };
  }

  async close(): Promise<void> {}
}
