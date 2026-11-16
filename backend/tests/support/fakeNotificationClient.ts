import type { Notification } from "pg";

import type { NotificationClient } from "../../src/shared/infra/postgresNotificationListener.js";

type Handlers = {
  error: Array<(error: Error) => void>;
  end: Array<() => void>;
  notification: Array<(message: Notification) => void>;
};

/** A `pg` client the test plays the server's side of: it answers queries, delivers notifications, and drops. */
export class FakeNotificationClient implements NotificationClient {
  readonly queries: string[] = [];
  ended = false;
  /** How a query is answered; at once by default. A test swaps it to make the server go quiet. */
  answer: (text: string) => Promise<unknown> = () => Promise.resolve({ rows: [] });
  private readonly handlers: Handlers = { error: [], end: [], notification: [] };

  on(event: "error", listener: (error: Error) => void): this;
  on(event: "end", listener: () => void): this;
  on(event: "notification", listener: (message: Notification) => void): this;
  on(event: keyof Handlers, listener: never): this {
    (this.handlers[event] as unknown[]).push(listener);
    return this;
  }

  connect(): Promise<void> {
    return Promise.resolve();
  }

  query(text: string): Promise<unknown> {
    this.queries.push(text);
    return this.answer(text);
  }

  end(): Promise<void> {
    this.ended = true;
    return Promise.resolve();
  }

  escapeIdentifier(identifier: string): string {
    return `"${identifier}"`;
  }

  /** A notification arriving on `channel`, as Postgres delivers one. */
  notify(channel: string, payload: string): void {
    for (const handler of this.handlers.notification) {
      handler({ channel, payload, processId: 1 });
    }
  }

  /** The connection failing, as `pg` reports it. */
  drop(error = new Error("Connection terminated unexpectedly")): void {
    for (const handler of this.handlers.error) {
      handler(error);
    }
  }
}

/** A client factory for the listener that keeps every client it opened, newest last. */
export const fakeNotificationClients = () => {
  const clients: FakeNotificationClient[] = [];
  return {
    clients,
    createClient: () => {
      const client = new FakeNotificationClient();
      clients.push(client);
      return client;
    },
    latest: (): FakeNotificationClient => {
      const client = clients.at(-1);
      if (!client) {
        throw new Error("the listener has not opened a client");
      }
      return client;
    },
  };
};
