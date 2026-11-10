import type {
  AgentConverseOpening,
  AgentConversePrincipal,
  AgentConversePrincipalPort,
  AgentConverseRefusal,
} from "../../settings/contracts/agentConverseSession.js";
import type { A2aContextSealer, A2aTaskRecord, A2aTaskStore, A2aTranscriptPort } from "../contracts/ports.js";
import { a2aError, radiosoError } from "../domain/a2aErrors.js";
import type { A2aCallInput } from "../domain/requestParams.js";
import type { A2aObserver } from "./a2aObserver.js";

/** Who is calling, as the HTTP edge resolved it: the path's agent, a bearer, the source digest. */
export interface A2aCaller {
  agentId: string;
  publicId: string;
  bearer: string | null;
  sourceDigest: string | null;
}

/** A context the caller is admitted to: the principal its turns run as, and what names it. */
export interface A2aContextAdmission {
  kind: "context";
  principal: AgentConversePrincipal;
  opening: AgentConverseOpening;
  /** The context id the caller holds, minted now when this request opened the context. */
  contextToken: string;
  /** The context's conversation, once its first turn created one. */
  conversationId: string | null;
  /** The task the request named, when it named one. */
  task: A2aTaskRecord | null;
}

export type A2aAdmission =
  | A2aContextAdmission
  /** `ListTasks` with no `contextId`: it lists nothing, so it needs no admission. */
  | { kind: "anonymous" }
  /** Opening a context was refused: an HTTP-level answer, as credentials are. */
  | { kind: "refused"; refusal: AgentConverseRefusal };

/**
 * Admits an A2A call. A call with no context opens one, through the walk-in door or a converse
 * grant, the same origin checks MCP's exchange runs. A call naming a context or a task re-verifies
 * the origin sealed in it, under the credential presented now: a grant context continues only for
 * the same grant, and no context continues for another agent.
 *
 * Every way a named context or task can fail — unreadable, another agent's, expired, revoked, or
 * another caller's — answers identically (`CONTEXT_NOT_FOUND`, or `TASK_NOT_FOUND` for a task), so
 * none can be told apart. Only opening a context refuses at the HTTP level, where the card already
 * says whether walk-in is open.
 */
export class A2aAccessResolver {
  constructor(
    private readonly dependencies: {
      principals: AgentConversePrincipalPort;
      sealer: A2aContextSealer;
      tasks: Pick<A2aTaskStore, "findById">;
      transcript: Pick<A2aTranscriptPort, "conversationIdFor">;
      observer: A2aObserver;
    },
  ) {}

  async admit(call: A2aCallInput, caller: A2aCaller): Promise<A2aAdmission> {
    switch (call.method) {
      case "SendMessage": {
        const { taskId, contextId } = call.params;
        if (taskId) {
          const admission = await this.task(call.method, taskId, caller);
          if (contextId && !this.sameContext(contextId, admission.opening)) {
            throw a2aError("INVALID_PARAMS");
          }
          return admission;
        }
        return contextId ? this.context(call.method, contextId, caller) : this.open(caller);
      }
      case "GetTask":
      case "CancelTask":
        return this.task(call.method, call.params.id, caller);
      case "ListTasks":
        return call.params.contextId ? this.context(call.method, call.params.contextId, caller) : { kind: "anonymous" };
    }
  }

  private async open(caller: A2aCaller): Promise<A2aAdmission> {
    const opened = await this.dependencies.principals.open(caller.bearer
      ? { launchToken: caller.bearer }
      : { publicId: caller.publicId, ...(caller.sourceDigest ? { sourceDigest: caller.sourceDigest } : {}) });
    if (!opened.ok) {
      return this.refuseOpening(opened.refusal, caller);
    }
    if (opened.opening.agentId !== caller.agentId) {
      // A live grant for another agent is still not a grant for this one.
      return this.refuseOpening({ statusCode: 403, code: "agent_mismatch" }, caller);
    }
    return {
      kind: "context",
      principal: opened.principal,
      opening: opened.opening,
      contextToken: this.dependencies.sealer.seal(opened.opening),
      conversationId: null,
      task: null,
    };
  }

  private async context(method: string, contextId: string, caller: A2aCaller): Promise<A2aContextAdmission> {
    const opening = this.dependencies.sealer.open(contextId);
    if (!opening || opening.agentId !== caller.agentId) {
      this.refused(method, "context_unreadable", caller);
      throw radiosoError("CONTEXT_NOT_FOUND");
    }
    const verified = await this.dependencies.principals.verify(opening, this.presented(caller));
    if (!verified.ok) {
      this.refused(method, verified.refusal.code, caller);
      throw radiosoError("CONTEXT_NOT_FOUND");
    }
    return {
      kind: "context",
      principal: verified.principal,
      opening,
      contextToken: contextId,
      conversationId: await this.dependencies.transcript.conversationIdFor(opening),
      task: null,
    };
  }

  private async task(method: string, taskId: string, caller: A2aCaller): Promise<A2aContextAdmission> {
    const task = await this.dependencies.tasks.findById(taskId);
    const opening = task ? this.dependencies.sealer.open(task.contextToken) : null;
    if (!task || !opening || opening.agentId !== caller.agentId) {
      throw a2aError("TASK_NOT_FOUND");
    }
    const verified = await this.dependencies.principals.verify(opening, this.presented(caller));
    if (!verified.ok) {
      this.refused(method, verified.refusal.code, caller, taskId);
      throw a2aError("TASK_NOT_FOUND");
    }
    return {
      kind: "context",
      principal: verified.principal,
      opening,
      contextToken: task.contextToken,
      conversationId: task.conversationId,
      task,
    };
  }

  /** A `contextId` sent beside a `taskId` must name the task's own context. */
  private sameContext(contextId: string, opening: AgentConverseOpening): boolean {
    const named = this.dependencies.sealer.open(contextId);
    return named !== null
      && named.workspaceId === opening.workspaceId
      && named.agentId === opening.agentId
      && named.publicSessionId === opening.publicSessionId;
  }

  private refuseOpening(refusal: AgentConverseRefusal, caller: A2aCaller): A2aAdmission {
    this.refused("SendMessage", refusal.code, caller);
    return { kind: "refused", refusal };
  }

  private presented(caller: A2aCaller): { launchToken?: string } {
    return caller.bearer ? { launchToken: caller.bearer } : {};
  }

  private refused(method: string, code: string, caller: A2aCaller, taskId?: string): void {
    this.dependencies.observer.refused({ method, code, agentId: caller.agentId, sourceDigest: caller.sourceDigest, taskId });
  }
}
