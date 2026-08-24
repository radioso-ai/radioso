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

export interface WorkspaceEventSubscription extends AsyncIterable<PushEvent> {
  /**
   * Reports and clears a request to send the existing full-refetch signal
   * before the next retained event. Implementations without buffering may omit it.
   */
  consumeResync?(): boolean;
}

export interface WorkspaceEventBus {
  publish(event: WorkspaceEventPublish): Promise<void>;
  subscribe(workspaceId: string): WorkspaceEventSubscription;
  /**
   * Resolves once the transport can deliver events to subscribers. A caller
   * that signals "refetch now" (the SSE ready frame) awaits this first — with
   * a cap — so the refetch lands after the point where events stop being lost.
   */
  ready(options?: { signal?: AbortSignal }): Promise<void>;
  close(): Promise<void>;
}

interface Subscriber {
  queue: PushEvent[];
  resolve?: (result: IteratorResult<PushEvent>) => void;
  closed: boolean;
  resyncRequired: boolean;
}

export class InMemoryWorkspaceEventBus implements WorkspaceEventBus {
  #nextVersion = 1;
  readonly #subscribersByWorkspace = new Map<string, Set<Subscriber>>();

  async ready(_options: { signal?: AbortSignal } = {}): Promise<void> {}

  async publish(event: WorkspaceEventPublish): Promise<void> {
    const frame = pushEventSchema.parse({ ...event, version: this.#nextVersion++ });
    const workspaceSubscribers = this.#subscribersByWorkspace.get(frame.workspaceId);
    if (!workspaceSubscribers) {
      return;
    }
    for (const subscriber of workspaceSubscribers) {
      if (subscriber.closed) {
        continue;
      }

      if (subscriber.resolve) {
        const resolve = subscriber.resolve;
        subscriber.resolve = undefined;
        resolve({ done: false, value: frame });
      } else if (subscriber.queue.length >= 256) {
        subscriber.queue.length = 0;
        subscriber.queue.push(frame);
        subscriber.resyncRequired = true;
      } else {
        subscriber.queue.push(frame);
      }
    }
  }

  subscribe(workspaceId: string): WorkspaceEventSubscription {
    const subscriber: Subscriber = { queue: [], closed: false, resyncRequired: false };
    const workspaceSubscribers = this.#subscribersByWorkspace.get(workspaceId) ?? new Set<Subscriber>();
    workspaceSubscribers.add(subscriber);
    this.#subscribersByWorkspace.set(workspaceId, workspaceSubscribers);

    const close = () => {
      if (subscriber.closed) {
        return;
      }
      subscriber.closed = true;
      workspaceSubscribers.delete(subscriber);
      if (workspaceSubscribers.size === 0) {
        this.#subscribersByWorkspace.delete(workspaceId);
      }
      subscriber.resolve?.({ done: true, value: undefined });
      subscriber.resolve = undefined;
    };

    return {
      consumeResync: () => {
        const resyncRequired = subscriber.resyncRequired;
        subscriber.resyncRequired = false;
        return resyncRequired;
      },
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
    for (const workspaceSubscribers of this.#subscribersByWorkspace.values()) {
      for (const subscriber of workspaceSubscribers) {
        subscriber.closed = true;
        subscriber.resolve?.({ done: true, value: undefined });
        subscriber.resolve = undefined;
      }
    }
    this.#subscribersByWorkspace.clear();
  }
}

export class NoopWorkspaceEventBus implements WorkspaceEventBus {
  async ready(_options: { signal?: AbortSignal } = {}): Promise<void> {}

  async publish(_event: WorkspaceEventPublish): Promise<void> {}

  subscribe(_workspaceId: string): AsyncIterable<PushEvent> {
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<PushEvent> {},
    };
  }

  async close(): Promise<void> {}
}
