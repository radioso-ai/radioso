import { traceOperation } from "../../../shared/observability/tracing/operations.js";
import type { A2aCallInput } from "../domain/requestParams.js";
import type { A2aAccessResolver, A2aAdmission, A2aCaller, A2aContextAdmission } from "./a2aAccess.js";
import type { A2aSendMessageService, SendMessageResult } from "./a2aSendMessage.js";
import type { A2aTaskReader } from "./a2aTaskReads.js";

/** An admission a method can run under: a context, or none for a `ListTasks` that names none. */
type A2aDispatchableAdmission = Exclude<A2aAdmission, { kind: "refused" }>;

const contextOf = (admission: A2aDispatchableAdmission): A2aContextAdmission | null =>
  admission.kind === "context" ? admission : null;

const taskStateOf = (result: SendMessageResult): string => ("task" in result ? result.task.status.state : "message");

/**
 * The four methods slice 1 serves, behind one admission step. The HTTP edge admits first, so the
 * rate limits keyed by the admitted caller answer before any method runs, then dispatches.
 */
export class A2aService {
  constructor(
    private readonly dependencies: {
      access: A2aAccessResolver;
      send: A2aSendMessageService;
      reads: A2aTaskReader;
    },
  ) {}

  admit(call: A2aCallInput, caller: A2aCaller): Promise<A2aAdmission> {
    return this.dependencies.access.admit(call, caller);
  }

  async handle(call: A2aCallInput, admission: A2aDispatchableAdmission, options: { extensionActive: boolean }): Promise<unknown> {
    const context = contextOf(admission);
    switch (call.method) {
      case "SendMessage": {
        if (!context) {
          throw new Error("SendMessage dispatched without a context admission");
        }
        // The span wraps the turn, so the chat turn's spans are its children.
        return traceOperation({
          name: "a2a.send_message",
          attributes: { "a2a.method": call.method },
          run: () => this.dependencies.send.send(context, call.params, options),
          resultAttributes: (result) => ({ "a2a.task_state": taskStateOf(result) }),
        });
      }
      case "GetTask":
        if (!context) {
          throw new Error("GetTask dispatched without a context admission");
        }
        return this.dependencies.reads.get(context, call.params, options);
      case "ListTasks":
        return this.dependencies.reads.list(context, call.params, options);
      case "CancelTask":
        if (!context) {
          throw new Error("CancelTask dispatched without a context admission");
        }
        return this.dependencies.reads.cancel(context);
    }
  }
}
