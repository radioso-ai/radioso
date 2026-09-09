"use client";

import {
  type FormEvent,
  type KeyboardEvent,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { AlertCircle, Ellipsis, Loader2, Plus, Send, X } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ChatMessageThread,
  type ChatThreadMessage,
} from "@/components/dashboard/chat-message-thread";
import { buildAssistantIdentity } from "@/components/chat/assistant-identity";
import { TestExecutionHistoryView } from "@/components/dashboard/test-execution-history-view";
import { TestSessionsView } from "@/components/dashboard/workbench/test-sessions-view";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  agentRevisionsApi,
  type AgentRevisionDetail,
  type AgentRevisionState,
  type AgentRevisionSummary,
  type ExecutionState,
  type RevisionEvalRun,
  type TestExecutionEvent,
  type TestExecutionHistoryDetail,
} from "@/lib/api-agent-revisions";
import {
  beginTestExecutionRetry,
  beginTestExecutionTurn,
  finalizeTestExecutionStream,
  hydrateTestExecutionState,
  initializeTestExecutionState,
  reduceTestExecutionEvent,
  type TestExecutionState,
} from "@/lib/agent-test-execution-state";
import { evalsApi, type EvalCaseListItem } from "@/lib/api-eval";
import { contextVariablesApi } from "@/lib/api-context-variables";
import { validateTestValueInputs } from "@/lib/agent-revision-test-values";
import { isAgentDraftDirty, saveAgentDraft } from "@/lib/agent-draft-save-port";
import { DEFAULT_WEBSITE_EMBED_COPY } from "@/lib/embed-widget";
import {
  agentRevisionTestChatSessionKey,
  readAgentRevisionTestChatSession,
  startAgentRevisionTestChatSession,
  subscribeAgentRevisionTestChatSession,
  writeAgentRevisionTestChatSession,
  type AgentRevisionTestChatSession,
} from "@/lib/agent-revision-test-chat-session";
import type { ContextVariable } from "@/lib/api-types";

type Mode = "single" | "compare";
type View = "chat" | "history";

const revisionDisplayLabel = (revision: AgentRevisionSummary): string => {
  if (revision.kind === "published" && revision.versionNumber !== null)
    return `v${revision.versionNumber}`;
  if (revision.kind === "candidate")
    return `Draft · ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(revision.createdAt))}`;
  return "Legacy revision";
};

const executionStateLabel: Record<ExecutionState, string> = {
  missing: "Not run",
  running: "Running",
  partial: "Partial",
  failed: "Failed",
  completed: "Completed",
};

const outcomeLabel: Record<
  RevisionEvalRun["sides"][number]["cases"][number]["outcome"],
  string
> = {
  pass: "Passed",
  fail: "Failed",
  partial: "Partial",
  unavailable: "Unavailable",
};

const evidenceLabel: Record<
  RevisionEvalRun["sides"][number]["evidenceState"],
  string
> = {
  current: "Current",
  configuration_changed: "Configuration changed since run",
  environment_changed: "Environment changed since run",
  comparability_unknown: "Comparability unknown (live dependencies)",
};

const failureLabel = (code: string) =>
  ({
    provider_unavailable: "The provider was unavailable.",
    stream_transport_failed: "The response stream was interrupted.",
    stream_ended_before_terminal_event: "The response ended before completion.",
    retry_transport_failed: "The retry response stream was interrupted.",
  })[code] ?? "This test side failed.";

const parseEvents = async (
  response: Response,
  onEvent: (event: TestExecutionEvent) => void,
): Promise<boolean> => {
  const reader = response.body?.getReader();
  if (!reader) return false;
  const decoder = new TextDecoder();
  let buffer = "";
  let sawExecutionTerminal = false;
  const parseFrame = (frame: string) => {
    const data = frame
      .split("\n")
      .find((line) => line.startsWith("data:"))
      ?.slice(5)
      .trim();
    if (!data) return;
    try {
      const event = JSON.parse(data) as TestExecutionEvent;
      if (
        event.type === "execution_completed" ||
        event.type === "execution_partial"
      )
        sawExecutionTerminal = true;
      onEvent(event);
    } catch {
      /* malformed event is ignored; server completion remains authoritative */
    }
  };
  for (;;) {
    const result = await reader.read();
    if (result.done) {
      if (buffer.trim()) parseFrame(buffer);
      return sawExecutionTerminal;
    }
    buffer += decoder.decode(result.value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) parseFrame(frame);
  }
};

export function AgentRevisionTestChat({
  agentId,
  workspaceId,
  assistantName,
  evalsHref,
  actionsContainer,
}: {
  agentId: string;
  workspaceId: string;
  assistantName?: string;
  evalsHref: string;
  actionsContainer: HTMLElement | null;
}) {
  const sessionKey = agentRevisionTestChatSessionKey(workspaceId, agentId);
  const cachedSession = readAgentRevisionTestChatSession(sessionKey);
  const [state, setState] = useState<AgentRevisionState | null>(cachedSession?.state ?? null);
  const [revisions, setRevisions] = useState<AgentRevisionSummary[]>(cachedSession?.revisions ?? []);
  const [mode, setMode] = useState<Mode>(cachedSession?.mode ?? "single");
  const [view, setView] = useState<View>(cachedSession?.view ?? "chat");
  const [selected, setSelected] = useState<string[]>(cachedSession?.selected ?? []);
  const [contextOpen, setContextOpen] = useState(false);
  const [evalsOpen, setEvalsOpen] = useState(false);
  const [message, setMessage] = useState(cachedSession?.message ?? "");
  const [execution, setExecution] = useState<TestExecutionState | null>(cachedSession?.execution ?? null);
  const [evalRun, setEvalRun] = useState<RevisionEvalRun | null>(cachedSession?.evalRun ?? null);
  const [error, setError] = useState<string | null>(cachedSession?.error ?? null);
  const [loading, setLoading] = useState(!cachedSession?.state);
  const [cases, setCases] = useState<EvalCaseListItem[]>(cachedSession?.cases ?? []);
  const [selectedCaseIds, setSelectedCaseIds] = useState<string[]>(cachedSession?.selectedCaseIds ?? []);
  const [restartNotice, setRestartNotice] = useState<string | null>(cachedSession?.restartNotice ?? null);
  const [revisionDetails, setRevisionDetails] = useState<
    Record<string, AgentRevisionDetail>
  >(cachedSession?.revisionDetails ?? {});
  const [contextVariables, setContextVariables] = useState<ContextVariable[]>(
    cachedSession?.contextVariables ?? [],
  );
  const [valueInputs, setValueInputs] = useState<Record<string, string>>(cachedSession?.valueInputs ?? {});
  const [revisionValueError, setRevisionValueError] = useState<string | null>(cachedSession?.revisionValueError ?? null);
  const [isSending, setIsSending] = useState(cachedSession?.isSending ?? false);
  const [isStarting, setIsStarting] = useState(cachedSession?.isStarting ?? false);
  const [isRunningEvals, setIsRunningEvals] = useState(cachedSession?.isRunningEvals ?? false);
  const [retryingEvalCase, setRetryingEvalCase] = useState<string | null>(cachedSession?.retryingEvalCase ?? null);
  const messageAbort = useRef<AbortController | null>(null);
  const startAbort = useRef<AbortController | null>(null);
  const evalPollTimeout = useRef<number | null>(null);
  const executionPollTimeout = useRef<number | null>(null);
  const reopenedExecutionId = useRef<string | null>(null);
  const activeEvalRunId = useRef<string | null>(cachedSession?.evalRun?.id ?? null);
  const evalRequestGeneration = useRef(0);
  const loadRequestGeneration = useRef(0);
  const testRequestGeneration = useRef(0);
  const activeChatAttempt = useRef<{
    requestGeneration: number;
    executionId: string;
    generation: number;
    turnId: string;
    attemptId: string;
    executionEpoch: number;
  } | null>(null);
  const evalStartInFlight = useRef(false);
  const savingDraftForSend = useRef(false);
  const proactiveStartKey = useRef<string | null>(cachedSession?.proactiveStartKey ?? null);
  const threadScrollContainers = useRef<Record<string, HTMLDivElement | null>>({});
  const followLatestMessage = useRef<Record<string, boolean>>({});
  const executionRef = useRef(execution);
  const evalRunRef = useRef(evalRun);
  executionRef.current = execution;
  evalRunRef.current = evalRun;

  const selectedVariables = useMemo(() => {
    const details = selected
      .map((id) => revisionDetails[id])
      .filter((detail): detail is AgentRevisionDetail => Boolean(detail));
    if (details.length !== selected.length) return null;
    const enabledIds =
      details[0]?.enabledContextVariableIds?.filter((id) =>
        details.every((detail) =>
          detail.enabledContextVariableIds?.includes(id),
        ),
      ) ?? [];
    return enabledIds.map((id) => ({
      id,
      variable: contextVariables.find((variable) => variable.id === id) ?? null,
    }));
  }, [contextVariables, revisionDetails, selected]);
  const excludedVariables = useMemo(() => {
    const details = selected
      .map((id) => revisionDetails[id])
      .filter((detail): detail is AgentRevisionDetail => Boolean(detail));
    if (mode !== "compare" || details.length !== selected.length) return [];
    const shared = new Set(
      details[0]?.enabledContextVariableIds.filter((id) =>
        details.every((detail) =>
          detail.enabledContextVariableIds.includes(id),
        ),
      ) ?? [],
    );
    const labels = new Map<string, string[]>();
    details.forEach((detail) =>
      detail.enabledContextVariableIds
        .filter((id) => !shared.has(id))
        .forEach((id) => {
          labels.set(id, [
            ...(labels.get(id) ?? []),
            revisions.find((revision) => revision.id === detail.id)?.label ??
              detail.label,
          ]);
        }),
    );
    return [...labels].map(([id, enabledFor]) => ({
      id,
      name: contextVariables.find((variable) => variable.id === id)?.name ?? id,
      enabledFor,
    }));
  }, [contextVariables, mode, revisionDetails, revisions, selected]);
  const valueValidation = useMemo(() => validateTestValueInputs(
    selectedVariables?.flatMap(({ id, variable }) => variable ? [{ id, name: variable.name, valueType: variable.valueType }] : []) ?? [],
    valueInputs,
  ), [selectedVariables, valueInputs]);
  const testValues = valueValidation.values;
  const valueError = revisionValueError ?? Object.values(valueValidation.errors)[0] ?? null;
  const agentCases = useMemo(
    () => cases.filter((evalCase) => evalCase.agent.agentId === agentId),
    [agentId, cases],
  );
  const assistantIdentity = useMemo(
    () => buildAssistantIdentity(DEFAULT_WEBSITE_EMBED_COPY, assistantName?.trim() || "Your agent"),
    [assistantName],
  );
  const availableSelectedCaseIds = selectedCaseIds.filter((caseId) =>
    agentCases.some((evalCase) => evalCase.id === caseId),
  );
  const setExecutionState = useCallback((next: SetStateAction<TestExecutionState | null>) => {
    const current = readAgentRevisionTestChatSession(sessionKey)?.execution ?? executionRef.current;
    const resolved = typeof next === "function" ? next(current) : next;
    writeAgentRevisionTestChatSession(sessionKey, { execution: resolved });
    setExecution(resolved);
  }, [sessionKey]);
  const setEvalRunState = useCallback((next: SetStateAction<RevisionEvalRun | null>) => {
    const current = readAgentRevisionTestChatSession(sessionKey)?.evalRun ?? evalRunRef.current;
    const resolved = typeof next === "function" ? next(current) : next;
    writeAgentRevisionTestChatSession(sessionKey, { evalRun: resolved });
    setEvalRun(resolved);
  }, [sessionKey]);
  const setSendingState = useCallback((next: boolean) => {
    writeAgentRevisionTestChatSession(sessionKey, { isSending: next });
    setIsSending(next);
  }, [sessionKey]);
  const setStartingState = useCallback((next: boolean) => {
    writeAgentRevisionTestChatSession(sessionKey, { isStarting: next });
    setIsStarting(next);
  }, [sessionKey]);
  const setRunningEvalsState = useCallback((next: boolean) => {
    writeAgentRevisionTestChatSession(sessionKey, { isRunningEvals: next });
    setIsRunningEvals(next);
  }, [sessionKey]);
  useEffect(() => {
    startAgentRevisionTestChatSession(sessionKey, {
      state,
      revisions,
      mode,
      view,
      selected,
      message,
      execution,
      evalRun,
      error,
      cases,
      selectedCaseIds,
      restartNotice,
      revisionDetails,
      contextVariables,
      valueInputs,
      valueError,
      revisionValueError,
      isSending,
      isStarting,
      isRunningEvals,
      retryingEvalCase,
      proactiveStartKey: proactiveStartKey.current,
      executionEpoch: readAgentRevisionTestChatSession(sessionKey)?.executionEpoch ?? 0,
    } satisfies AgentRevisionTestChatSession);
  }, [
    cases,
    contextVariables,
    error,
    evalRun,
    execution,
    isRunningEvals,
    isSending,
    isStarting,
    message,
    mode,
    restartNotice,
    retryingEvalCase,
    revisionDetails,
    revisions,
    selected,
    selectedCaseIds,
    sessionKey,
    state,
    valueError,
    valueInputs,
    revisionValueError,
    view,
  ]);
  useEffect(
    () =>
      subscribeAgentRevisionTestChatSession(sessionKey, () => {
        const next = readAgentRevisionTestChatSession(sessionKey);
        if (!next) return;
        setExecution(next.execution);
        setEvalRun(next.evalRun);
        setIsSending(next.isSending);
        setIsStarting(next.isStarting);
        setIsRunningEvals(next.isRunningEvals);
      }),
    [sessionKey],
  );
  const clearEvalPoll = useCallback(() => {
    if (evalPollTimeout.current !== null)
      window.clearTimeout(evalPollTimeout.current);
    evalPollTimeout.current = null;
  }, []);
  const clearExecutionPoll = useCallback(() => {
    if (executionPollTimeout.current !== null)
      window.clearTimeout(executionPollTimeout.current);
    executionPollTimeout.current = null;
    reopenedExecutionId.current = null;
  }, []);
  const clearChatExecution = useCallback(
    (notice?: string) => {
      testRequestGeneration.current += 1;
      activeChatAttempt.current = null;
      messageAbort.current?.abort();
      messageAbort.current = null;
      startAbort.current?.abort();
      startAbort.current = null;
      clearExecutionPoll();
      const executionEpoch = (readAgentRevisionTestChatSession(sessionKey)?.executionEpoch ?? 0) + 1;
      writeAgentRevisionTestChatSession(sessionKey, { executionEpoch });
      setExecutionState(null);
      followLatestMessage.current = {};
      if (notice) setRestartNotice(notice);
      setSendingState(false);
      setStartingState(false);
    },
    [clearExecutionPoll, sessionKey, setExecutionState, setSendingState, setStartingState],
  );
  const clearActiveTest = useCallback(
    (notice?: string) => {
      clearChatExecution(notice);
      activeEvalRunId.current = null;
      evalRequestGeneration.current += 1;
      clearEvalPoll();
      setEvalRunState(null);
    },
    [clearChatExecution, clearEvalPoll, setEvalRunState],
  );

  const load = useCallback(async () => {
    const requestGeneration = loadRequestGeneration.current + 1;
    loadRequestGeneration.current = requestGeneration;
    clearActiveTest();
    setLoading(true);
    setError(null);
    try {
      const next = await agentRevisionsApi.getState(agentId);
      const [published, candidate, evalCases, catalog] = await Promise.all([
        agentRevisionsApi.listPublished(agentId),
        agentRevisionsApi.createCandidate(agentId, next.draft.generation),
        evalsApi.listCases(),
        contextVariablesApi.listCatalog(),
      ]);
      const all = [
        candidate.candidate,
        ...published.revisions.filter(
          (revision) => revision.id !== candidate.candidate.id,
        ),
      ];
      if (loadRequestGeneration.current !== requestGeneration) return;
      setState(next);
      setRevisions(all);
      setSelected([candidate.candidate.id]);
      setCases(evalCases.cases);
      setContextVariables(catalog.contextVariables);
    } catch (cause) {
      if (loadRequestGeneration.current === requestGeneration)
        setError(
          cause instanceof Error
            ? cause.message
            : "Revision testing is unavailable.",
        );
    } finally {
      if (loadRequestGeneration.current === requestGeneration)
        setLoading(false);
    }
  }, [agentId, clearActiveTest]);
  useEffect(() => {
    if (readAgentRevisionTestChatSession(sessionKey)?.state) return;
    const timeout = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [load, sessionKey]);
  useEffect(() => {
    let active = true;
    if (!selected.length)
      return () => {
        active = false;
      };
    void Promise.all(
      selected.map(
        async (revisionId) =>
          [
            revisionId,
            await agentRevisionsApi.getRevision(agentId, revisionId),
          ] as const,
      ),
    )
      .then((results) => {
        if (!active) return;
        setRevisionDetails((current) => ({
          ...current,
          ...Object.fromEntries(
            results.map(([id, result]) => [id, result.revision]),
          ),
        }));
        setRevisionValueError(null);
      })
      .catch((cause) => {
        if (active)
          setRevisionValueError(
            cause instanceof Error
              ? cause.message
              : "Selected revision values are unavailable.",
          );
      });
    return () => {
      active = false;
    };
  }, [agentId, selected]);
  useEffect(() => {
    const refreshForSavedDraft = (event: Event) => {
      const detail = (event as CustomEvent<{ agentId?: string }>).detail;
      if (detail?.agentId === agentId && !savingDraftForSend.current) {
        clearActiveTest(
          "Saved draft selected. Start a fresh private test for this revision.",
        );
        void load();
      }
    };
    window.addEventListener("radioso:agent-draft-saved", refreshForSavedDraft);
    return () =>
      window.removeEventListener(
        "radioso:agent-draft-saved",
        refreshForSavedDraft,
      );
  }, [agentId, load, clearActiveTest]);
  useEffect(() => {
    Object.entries(threadScrollContainers.current).forEach(([key, container]) => {
      if (container && followLatestMessage.current[key] !== false) {
        container.scrollTop = container.scrollHeight;
      }
    });
  }, [execution, view]);

  const start = async (
    nextMode = mode,
    nextSelected = selected,
    nextValues = testValues,
    expectedDraftGeneration = state?.draft.generation,
  ): Promise<TestExecutionState | null> => {
    if (
      expectedDraftGeneration === undefined ||
      (nextMode === "single" && nextSelected.length !== 1) ||
      (nextMode === "compare" && nextSelected.length !== 2)
    )
      return null;
    // Starting another private chat with the same immutable inputs is
    // independent from a running revision eval; only configuration changes
    // invalidate the frozen eval evidence and its poll lifecycle.
    clearChatExecution();
    const requestGeneration = testRequestGeneration.current;
    const executionEpoch = readAgentRevisionTestChatSession(sessionKey)?.executionEpoch ?? 0;
    const abortController = new AbortController();
    startAbort.current = abortController;
    setStartingState(true);
    setError(null);
    setRestartNotice(null);
    try {
      const started = await agentRevisionsApi.startTest(
        agentId,
        {
          mode: nextMode,
          revisionIds: nextSelected as [string] | [string, string],
          testValues: nextValues,
          expectedDraftGeneration,
        },
        abortController.signal,
      );
      if (
        testRequestGeneration.current !== requestGeneration ||
        readAgentRevisionTestChatSession(sessionKey)?.executionEpoch !== executionEpoch
      ) return null;
      const nextExecution = initializeTestExecutionState(started);
      setExecutionState(nextExecution);
      return nextExecution;
    } catch (cause) {
      if (
        testRequestGeneration.current === requestGeneration &&
        readAgentRevisionTestChatSession(sessionKey)?.executionEpoch === executionEpoch
      )
        setError(
          cause instanceof Error
            ? cause.message
            : "Unable to start this private test.",
        );
    } finally {
      if (startAbort.current === abortController) startAbort.current = null;
      if (
        testRequestGeneration.current === requestGeneration &&
        readAgentRevisionTestChatSession(sessionKey)?.executionEpoch === executionEpoch
      )
        setStartingState(false);
    }
    return null;
  };
  const startRef = useRef(start);
  startRef.current = start;

  useEffect(() => {
    if (
      loading ||
      !state?.proactiveGreetingEnabled ||
      !selected.length ||
      execution ||
      isStarting ||
      isAgentDraftDirty(agentId)
    ) return;
    const key = `${state.draft.generation}:${mode}:${selected.join(",")}`;
    if (proactiveStartKey.current === key) return;
    proactiveStartKey.current = key;
    writeAgentRevisionTestChatSession(sessionKey, { proactiveStartKey: key });
    void startRef.current();
  }, [agentId, execution, isStarting, loading, mode, selected, sessionKey, state]);

  const changeMode = useCallback(
    (next: Mode) => {
      const nextSelected =
        next === "single"
          ? selected.slice(-1)
          : selected.length === 2
            ? selected
            : [state?.publishedRevision?.id, selected[0]].filter(
                (id): id is string => Boolean(id),
              );
      setMode(next);
      setSelected(nextSelected);
      clearActiveTest(
        "Test mode changed. Start a fresh private test for these versions.",
      );
    },
    [clearActiveTest, selected, state?.publishedRevision?.id],
  );
  const closeComparisonSide = useCallback(async (index: number) => {
    const retainedIndex = index === 0 ? 1 : 0;
    const revisionId = selected[retainedIndex];
    if (!revisionId || mode !== "compare" || isSending || isStarting || execution?.activeTurnId) return;
    const side = execution && Object.values(execution.sides).find((candidate) => candidate.revisionId === revisionId);
    if (side?.state === "failed") return;
    setError(null);
    try {
      const retained = execution && side
        ? await agentRevisionsApi.retainTestSide(agentId, execution.executionId, side.id)
        : null;
      setMode("single");
      setSelected([revisionId]);
      if (retained) setExecutionState(initializeTestExecutionState(retained));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to continue this version as a single chat.");
    }
  }, [agentId, execution, isSending, isStarting, mode, selected, setExecutionState]);
  const updateSelection = useCallback(
    (index: number, revisionId: string) => {
      const next = [...selected];
      next[index] = revisionId;
      setSelected(next);
      clearActiveTest(
        "Revision changed. Start a fresh private test for this selection.",
      );
    },
    [clearActiveTest, selected],
  );
  const refreshSavedCandidate = async (
    previousSelection: string[],
    requestGeneration: number,
  ): Promise<{ state: AgentRevisionState; selected: string[] } | null> => {
    const next = await agentRevisionsApi.getState(agentId);
    const [published, candidate] = await Promise.all([
      agentRevisionsApi.listPublished(agentId),
      agentRevisionsApi.createCandidate(agentId, next.draft.generation),
    ]);
    if (testRequestGeneration.current !== requestGeneration) return null;
    const oldCandidateId = revisions.find(
      (revision) => revision.kind === "candidate",
    )?.id;
    const nextSelected = previousSelection.map((revisionId) =>
      revisionId === oldCandidateId ? candidate.candidate.id : revisionId,
    );
    setState(next);
    setRevisions([
      candidate.candidate,
      ...published.revisions.filter(
        (revision) => revision.id !== candidate.candidate.id,
      ),
    ]);
    setSelected(nextSelected);
    setRevisionDetails({});
    return { state: next, selected: nextSelected };
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!message.trim() || isSending || isStarting) return;
    const text = message.trim();
    const requestGeneration = testRequestGeneration.current;
    const nextMode = mode;
    let nextSelected = [...selected];
    const nextValues = testValues;
    let expectedDraftGeneration = state?.draft.generation;
    let active = execution;
    if (isAgentDraftDirty(agentId)) {
      savingDraftForSend.current = true;
      setStartingState(true);
      setError(null);
      try {
        await saveAgentDraft(agentId);
        if (testRequestGeneration.current !== requestGeneration) return;
        const refreshed = await refreshSavedCandidate(
          nextSelected,
          requestGeneration,
        );
        if (!refreshed) return;
        nextSelected = refreshed.selected;
        expectedDraftGeneration = refreshed.state.draft.generation;
        // The preceding conversation captured an older immutable candidate.
        // `start` creates a replacement execution after the refreshed candidate.
        active = null;
      } catch (cause) {
        if (testRequestGeneration.current === requestGeneration)
          setError(
            cause instanceof Error
              ? cause.message
              : "Unable to save the draft. The test was not started.",
          );
        return;
      } finally {
        savingDraftForSend.current = false;
        if (testRequestGeneration.current === requestGeneration)
          setStartingState(false);
      }
    }
    if (!active) {
      active = await start(
        nextMode,
        nextSelected,
        nextValues,
        expectedDraftGeneration,
      );
      if (!active) return;
    }
    if (active.state === "partial" || active.activeTurnId) return;
    const turnId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const activeRequestGeneration = testRequestGeneration.current;
    const executionEpoch = readAgentRevisionTestChatSession(sessionKey)?.executionEpoch ?? 0;
    const matchesAttempt = () => {
      const current = activeChatAttempt.current;
      return (
        current?.requestGeneration === activeRequestGeneration &&
        current.executionId === active.executionId &&
        current.generation === active.generation &&
        current.turnId === turnId &&
        current.attemptId === attemptId &&
        current.executionEpoch === executionEpoch &&
        readAgentRevisionTestChatSession(sessionKey)?.executionEpoch === executionEpoch
      );
    };
    setMessage("");
    setExecutionState(beginTestExecutionTurn(active, text, turnId, attemptId));
    setSendingState(true);
    const abortController = new AbortController();
    messageAbort.current = abortController;
    activeChatAttempt.current = {
      requestGeneration: activeRequestGeneration,
      executionId: active.executionId,
      generation: active.generation,
      turnId,
      attemptId,
      executionEpoch,
    };
    try {
      const response = await agentRevisionsApi.sendTestMessage(
        agentId,
        active.executionId,
        {
          message: text,
          executionGeneration: active.generation,
          turnId,
          attemptId,
        },
        abortController.signal,
      );
      const sawTerminal = await parseEvents(response, (incoming) => {
        if (matchesAttempt())
          setExecutionState((current) =>
            current ? reduceTestExecutionEvent(current, incoming) : null,
          );
      });
      if (matchesAttempt() && !sawTerminal)
        setExecutionState((current) =>
          current
            ? finalizeTestExecutionStream(
                current,
                "stream_ended_before_terminal_event",
              )
            : null,
        );
    } catch (cause) {
      if (
        matchesAttempt() &&
        !(cause instanceof DOMException && cause.name === "AbortError")
      ) {
        const message =
          cause instanceof Error ? cause.message : "Test message failed.";
        setError(message);
        setExecutionState((current) =>
          current
            ? finalizeTestExecutionStream(current, "stream_transport_failed")
            : null,
        );
      }
    } finally {
      if (matchesAttempt()) {
        if (messageAbort.current === abortController)
          messageAbort.current = null;
        activeChatAttempt.current = null;
        setSendingState(false);
      }
    }
  };
  const pollEval = async (runId: string, requestGeneration: number) => {
    if (
      activeEvalRunId.current !== runId ||
      evalRequestGeneration.current !== requestGeneration
    )
      return;
    try {
      const next = await agentRevisionsApi.getEval(runId);
      if (
        activeEvalRunId.current !== runId ||
        evalRequestGeneration.current !== requestGeneration
      )
        return;
      setEvalRunState(next);
      if (next.state === "running") {
        evalPollTimeout.current = window.setTimeout(() => {
          void pollEval(runId, requestGeneration);
        }, 750);
      }
    } catch (cause) {
      if (
        activeEvalRunId.current === runId &&
        evalRequestGeneration.current === requestGeneration
      )
        setError(
          cause instanceof Error
            ? cause.message
            : "Unable to refresh revision eval evidence.",
        );
    }
  };
  const runEvals = async () => {
    if (
      !selected.length ||
      !availableSelectedCaseIds.length ||
      evalStartInFlight.current ||
      evalRun?.state === "running"
    )
      return;
    if (valueError) return;
    evalStartInFlight.current = true;
    setRunningEvalsState(true);
    clearEvalPoll();
    const requestGeneration = evalRequestGeneration.current + 1;
    evalRequestGeneration.current = requestGeneration;
    activeEvalRunId.current = null;
    try {
      const started = await agentRevisionsApi.startEval({
        revisionIds: selected as [string] | [string, string],
        caseIds: availableSelectedCaseIds,
        testValues,
        mode: "full_assistant",
        executionPolicy: "safe_test",
      });
      if (evalRequestGeneration.current !== requestGeneration) return;
      activeEvalRunId.current = started.id;
      setEvalRunState(started);
      if (started.state === "running")
        void pollEval(started.id, requestGeneration);
    } catch (cause) {
      if (evalRequestGeneration.current === requestGeneration)
        setError(
          cause instanceof Error ? cause.message : "Unable to start evals.",
        );
    } finally {
      evalStartInFlight.current = false;
      if (evalRequestGeneration.current === requestGeneration)
        setRunningEvalsState(false);
    }
  };
  const retryEvalCase = async (revisionId: string, caseId: string) => {
    const active = evalRun;
    if (!active || retryingEvalCase) return;
    const retryKey = `${revisionId}:${caseId}`;
    setRetryingEvalCase(retryKey);
    setError(null);
    const requestGeneration = evalRequestGeneration.current;
    try {
      const next = await agentRevisionsApi.retryEvalCase(
        active.id,
        revisionId,
        caseId,
      );
      if (
        evalRequestGeneration.current !== requestGeneration ||
        activeEvalRunId.current !== active.id
      )
        return;
      setEvalRunState(next);
      if (next.state === "running") void pollEval(next.id, requestGeneration);
    } catch (cause) {
      if (evalRequestGeneration.current === requestGeneration)
        setError(
          cause instanceof Error
            ? cause.message
            : "Unable to retry this eval case.",
        );
    } finally {
      if (evalRequestGeneration.current === requestGeneration)
        setRetryingEvalCase(null);
    }
  };
  const retrySide = useCallback(
    async (sideId: string) => {
      const active = execution;
      const side = active?.sides[sideId];
      const lastFailedAssistant =
        side &&
        [...side.messages]
          .reverse()
          .find(
            (message) =>
              message.role === "assistant" && message.state === "failed",
          );
      if (!active || !side || !lastFailedAssistant || isSending) return;
      const attemptId = crypto.randomUUID();
      const requestGeneration = testRequestGeneration.current;
      const turnId = lastFailedAssistant.turnId;
      const executionEpoch = readAgentRevisionTestChatSession(sessionKey)?.executionEpoch ?? 0;
      const matchesAttempt = () => {
        const current = activeChatAttempt.current;
        return (
          current?.requestGeneration === requestGeneration &&
          current.executionId === active.executionId &&
          current.generation === active.generation &&
          current.turnId === turnId &&
          current.attemptId === attemptId &&
          current.executionEpoch === executionEpoch &&
          readAgentRevisionTestChatSession(sessionKey)?.executionEpoch === executionEpoch
        );
      };
      setExecutionState(beginTestExecutionRetry(active, sideId, attemptId));
      setSendingState(true);
      const abortController = new AbortController();
      messageAbort.current = abortController;
      activeChatAttempt.current = {
        requestGeneration,
        executionId: active.executionId,
        generation: active.generation,
        turnId,
        attemptId,
        executionEpoch,
      };
      try {
        const response = await agentRevisionsApi.retryTestSide(
          agentId,
          active.executionId,
          sideId,
          { executionGeneration: active.generation, turnId, attemptId },
          abortController.signal,
        );
        const sawTerminal = await parseEvents(response, (incoming) => {
          if (matchesAttempt())
            setExecutionState((current) =>
              current ? reduceTestExecutionEvent(current, incoming) : null,
            );
        });
        if (matchesAttempt() && !sawTerminal)
          setExecutionState((current) =>
            current
              ? finalizeTestExecutionStream(
                  current,
                  "stream_ended_before_terminal_event",
                )
              : null,
          );
      } catch (cause) {
        if (
          matchesAttempt() &&
          !(cause instanceof DOMException && cause.name === "AbortError")
        ) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Unable to retry this test side.",
          );
          setExecutionState((current) =>
            current
              ? finalizeTestExecutionStream(current, "retry_transport_failed")
              : null,
          );
        }
      } finally {
        if (matchesAttempt()) {
          if (messageAbort.current === abortController)
            messageAbort.current = null;
          activeChatAttempt.current = null;
          setSendingState(false);
        }
      }
    },
    [agentId, execution, isSending, sessionKey, setExecutionState, setSendingState],
  );

  const pollReopenedExecution = useCallback(
    async function pollReopenedExecution(
      executionId: string,
      requestGeneration: number,
    ) {
      if (
        reopenedExecutionId.current !== executionId ||
        testRequestGeneration.current !== requestGeneration
      )
        return;
      try {
        const response = await agentRevisionsApi.getTestExecution(
          agentId,
          executionId,
        );
        if (
          reopenedExecutionId.current !== executionId ||
          testRequestGeneration.current !== requestGeneration
        )
          return;
        const next = hydrateTestExecutionState(response.execution);
        setExecutionState(next);
        if (
          response.execution.attempts.some(
            (attempt) => attempt.state === "running",
          )
        ) {
          executionPollTimeout.current = window.setTimeout(() => {
            void pollReopenedExecution(executionId, requestGeneration);
          }, 750);
        }
      } catch (cause) {
        if (
          reopenedExecutionId.current === executionId &&
          testRequestGeneration.current === requestGeneration
        ) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Unable to refresh this in-progress private test.",
          );
        }
      }
    },
    [agentId, setExecutionState],
  );

  const reopenExecution = useCallback(
    (saved: TestExecutionHistoryDetail) => {
      clearChatExecution();
      setMode(saved.mode);
      setSelected(saved.sides.map((side) => side.revision.id));
      setRevisions((current) => {
        const byId = new Map(
          current.map((revision) => [revision.id, revision]),
        );
        saved.sides.forEach((side) =>
          byId.set(side.revision.id, side.revision),
        );
        return [...byId.values()];
      });
      setValueInputs(
        Object.fromEntries(
          saved.testValues.map((value) => [
            value.contextVariableId,
            typeof value.value === "string"
              ? value.value
              : JSON.stringify(value.value),
          ]),
        ),
      );
      setExecutionState(hydrateTestExecutionState(saved));
      setRestartNotice(
        saved.attempts.some((attempt) => attempt.state === "running")
          ? "This saved test has an in-progress attempt. Its recorded state is preserved while the service resolves it."
          : "Reopened saved private test with its original immutable revisions and values.",
      );
      if (saved.attempts.some((attempt) => attempt.state === "running")) {
        const requestGeneration = testRequestGeneration.current;
        reopenedExecutionId.current = saved.id;
        void pollReopenedExecution(saved.id, requestGeneration);
      }
      setView("chat");
    },
    [clearChatExecution, pollReopenedExecution, setExecutionState],
  );

  if (loading)
    return (
      <div className="flex min-h-48 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  if (!state)
    return (
      <div className="m-6 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
        <AlertCircle className="mr-2 inline h-4 w-4" />
        Private revision testing is unavailable. No live chat is started.{" "}
        <Button variant="link" onClick={() => void load()}>
          Retry
        </Button>
      </div>
    );
  const selectedRevisions = selected
    .map((id) => revisions.find((revision) => revision.id === id))
    .filter((revision): revision is AgentRevisionSummary => Boolean(revision));
  const draftBaseVersion = () => {
    const base = revisions.find(
      (candidate) => candidate.id === state.draft.basePublishedRevisionId,
    );
    return base?.versionNumber ?? null;
  };
  const revisionTriggerLabel = (revision: AgentRevisionSummary | undefined) =>
    revision?.kind === "candidate" ? "Draft" : revision ? revisionDisplayLabel(revision) : "Choose revision";
  const revisionSelector = (index: number, className?: string) => {
    const selectedRevision = revisions.find((revision) => revision.id === selected[index]);
    return (
      <Select
        value={selected[index]}
        onValueChange={(id) => updateSelection(index, id)}
      >
        <SelectTrigger
          id={`revision-selector-${index}`}
          aria-label={`Revision ${index + 1}`}
          className={className}
        >
          <span data-slot="select-value">{revisionTriggerLabel(selectedRevision)}</span>
        </SelectTrigger>
        <SelectContent>
          {revisions.map((revision) => (
            <SelectItem key={revision.id} value={revision.id}>
              <span className="flex min-w-0 flex-col items-start gap-0.5 py-0.5">
                <span>{revisionTriggerLabel(revision)}</span>
                {revision.kind === "candidate" && draftBaseVersion() !== null ? (
                  <span className="text-xs font-normal text-muted-foreground">
                    based on v{draftBaseVersion()}
                  </span>
                ) : null}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  };
  const canPrepare =
    !isStarting &&
    !isSending &&
    selectedRevisions.length > 0 &&
    (mode !== "compare" || selectedRevisions.length === 2) &&
    !valueError &&
    selectedVariables !== null &&
    !selectedVariables.some(({ variable }) => !variable);
  const canSend =
    canPrepare &&
    (!execution || (execution.state !== "partial" && !execution.activeTurnId));
  const needsDraftSave = isAgentDraftDirty(agentId);
  const evalByRevision = new Map(
    evalRun?.sides.map((side) => [side.revisionId, side]) ?? [],
  );
  const blockingContextError =
    valueError ??
    (selectedVariables === null
      ? "Loading revision details…"
      : selectedVariables.some(({ variable }) => !variable)
        ? "A value enabled by this revision no longer exists in the workspace catalog. Testing is blocked until that revision is corrected."
        : null);
  const sendLabel = needsDraftSave
    ? "Save draft & send"
    : mode === "compare"
      ? "Send to both"
      : "Send";
  const submitOnEnter = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };
  const actionMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Test chat actions"
        >
          <Ellipsis className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onSelect={() => {
            proactiveStartKey.current = null;
            writeAgentRevisionTestChatSession(sessionKey, { proactiveStartKey: null });
            clearChatExecution("New chat ready.");
          }}
        >
          <Plus className="mr-2 h-4 w-4" />
          New chat
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setView("history")}>
          History
        </DropdownMenuItem>
        {mode === "single" ? (
          <DropdownMenuItem onSelect={() => changeMode("compare")}>
            Compare versions
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={() => setEvalsOpen(true)}>
          Evals
        </DropdownMenuItem>
        {selectedVariables && (selectedVariables.length > 0 || excludedVariables.length > 0) ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setContextOpen(true)}>
              Test context
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  const menu = actionsContainer ? (
    createPortal(actionMenu, actionsContainer)
  ) : (
    <div className="flex justify-end p-2">{actionMenu}</div>
  );
  return (
    <>
      {menu}
      <div className="flex h-full min-h-0 flex-col gap-4 p-6">
        {view === "history" ? (
          <div
            role="tabpanel"
            className="min-h-0 flex-1 space-y-8 overflow-y-auto"
          >
            <div className="flex items-center justify-between">
              <h2 className="font-medium">History</h2>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setView("chat")}
              >
                Back to chat
              </Button>
            </div>
            <section>
              <TestExecutionHistoryView
                agentId={agentId}
                onOpen={reopenExecution}
              />
            </section>
            <section>
              <TestSessionsView agentId={agentId} />
            </section>
          </div>
        ) : (
          <>
            {error ? (
              <p
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
              >
                {error}
              </p>
            ) : null}
            {restartNotice ? (
              <p
                role="status"
                className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground"
              >
                {restartNotice}
              </p>
            ) : null}
            {execution?.state === "partial" ? (
              <p
                role="status"
                className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm"
              >
                Partial result: a side failed or is still incomplete. Successful
                evidence remains pinned to its revision.
              </p>
            ) : null}
            <div
              className={
                mode === "compare"
                  ? "grid min-h-0 flex-1 gap-4 lg:grid-cols-2"
                  : "flex min-h-0 flex-1 flex-col"
              }
            >
              {[0, ...(mode === "compare" ? [1] : [])].map((index) => (
                <section
                  key={index}
                  aria-label={
                    mode === "compare"
                      ? `${revisionTriggerLabel(revisions.find((revision) => revision.id === selected[index]))} test results`
                      : undefined
                  }
                  className={
                    "flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/70 bg-card/40"
                  }
                >
                  <div
                    className={
                      mode === "compare"
                        ? "flex shrink-0 justify-end border-b border-border/70 bg-muted/20 px-3 py-2"
                        : "flex shrink-0 items-center gap-2 border-b border-border/70 bg-muted/20 px-3 py-2"
                    }
                  >
                    <Label className="sr-only" htmlFor={`revision-selector-${index}`}>
                      Select version for {revisionTriggerLabel(revisions.find((revision) => revision.id === selected[index]))} test results
                    </Label>
                    <div className={mode === "single" ? "ml-auto flex items-center gap-2" : "flex items-center gap-2"}>
                      {revisionSelector(index, "h-8 border-border/70 bg-background/70 px-2 text-sm shadow-none")}
                      {mode === "single" ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-8 shrink-0"
                          onClick={() => changeMode("compare")}
                        >
                          Compare versions
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 shrink-0"
                          aria-label={`Close ${revisionTriggerLabel(revisions.find((revision) => revision.id === selected[index]))}`}
                          title={isSending || isStarting || execution?.activeTurnId ? "Wait for the current response before closing this version." : "Close this version"}
                          disabled={isSending || isStarting || Boolean(execution?.activeTurnId) || Boolean(Object.values(execution?.sides ?? {}).find((candidate) => candidate.revisionId === selected[index])?.state === "failed")}
                          onClick={() => void closeComparisonSide(index)}
                        >
                          <X className="h-4 w-4" aria-hidden="true" />
                        </Button>
                      )}
                    </div>
                  </div>
                  {(() => {
                    const side =
                      execution &&
                      Object.values(execution.sides).find(
                        (candidate) => candidate.revisionId === selected[index],
                      );
                    const messages: ChatThreadMessage[] =
                      side?.messages.map((item) => ({
                        id: item.id,
                        role: item.role,
                        content: item.content,
                        status:
                          item.state === "streaming"
                            ? "streaming"
                            : item.state === "completed"
                              ? "complete"
                              : "error",
                      })) ?? [];
                    return (
                      <>
                        <div
                          ref={(node) => {
                            threadScrollContainers.current[index] = node;
                          }}
                          onScroll={(event) => {
                            const container = event.currentTarget;
                            followLatestMessage.current[index] = container.scrollHeight - container.scrollTop - container.clientHeight < 48;
                          }}
                          className={
                            "radioso-themed-scrollbar min-h-0 flex-1 overflow-y-auto p-4"
                          }
                        >
                          {messages.length ? <ChatMessageThread
                            messages={messages}
                            onOpenDocument={async () => "unavailable"}
                            assistantAvatarLabel={assistantName}
                            assistantIdentity={assistantIdentity}
                          /> : mode === "single" ? <p className="mx-auto max-w-3xl pt-8 text-sm text-muted-foreground">Ask a question to test this version.</p> : null}
                          {side?.errorCode ? (
                            <p className="mt-3 text-sm text-destructive">
                              {failureLabel(side.errorCode)}
                            </p>
                          ) : null}
                          {side?.retryable || side?.recoveryAvailable ? (
                            <Button
                              size="sm"
                              variant="link"
                              disabled={isSending}
                              onClick={() => void retrySide(side.id)}
                            >
                              {side.recoveryAvailable
                                ? "Recover this side"
                                : "Retry this side"}
                            </Button>
                          ) : null}
                        </div>
                      </>
                    );
                  })()}
                </section>
              ))}
            </div>
            {blockingContextError ? (
              <p
                role="alert"
                className="mx-auto w-full max-w-3xl text-sm text-destructive"
              >
                {blockingContextError}
              </p>
            ) : null}
            <form onSubmit={submit} className="mx-auto w-full max-w-3xl">
              <div className="flex items-end gap-1 rounded-2xl border border-input bg-input/40 px-2 py-1.5 transition-colors focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-0">
                <Textarea
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  onKeyDown={submitOnEnter}
                  placeholder={
                    execution?.state === "partial"
                      ? "Retry the failed side or start a new chat"
                      : "Ask a question..."
                  }
                  className="min-h-[36px] max-h-32 flex-1 resize-none border-0 bg-transparent px-2 py-1.5 shadow-none focus-visible:ring-0"
                  disabled={!canSend}
                />
                <Button
                  type="submit"
                  size="icon"
                  className="shrink-0 rounded-full"
                  aria-label={sendLabel}
                  title={sendLabel}
                  disabled={!canSend || !message.trim()}
                >
                  {isStarting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                  <span className="sr-only">{sendLabel}</span>
                </Button>
              </div>
            </form>
            <Dialog open={contextOpen} onOpenChange={setContextOpen}>
              <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>Test context</DialogTitle>
                  <DialogDescription>
                    Sample context used only for this private test.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                  {excludedVariables.length ? (
                    <p className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-900 dark:text-amber-100">
                      These versions use different context:{" "}
                      {excludedVariables
                        .map(
                          (variable) =>
                            `${variable.name} (enabled only in ${variable.enabledFor.join(" and ")})`,
                        )
                        .join(", ")}
                      . Switch to Single chat to add a sample for one version.
                    </p>
                  ) : null}
                  {valueError ? (
                    <p role="alert" className="mt-2 text-sm text-destructive">
                      {valueError}
                    </p>
                  ) : null}
                  {selectedVariables === null ? (
                    <p className="mt-3 text-sm text-muted-foreground">
                      Loading values for the selected revision…
                    </p>
                  ) : selectedVariables.some(({ variable }) => !variable) ? (
                    <p role="alert" className="mt-3 text-sm text-destructive">
                      A value enabled by this revision no longer exists in the
                      workspace catalog. Testing is blocked until that revision
                      is corrected.
                    </p>
                  ) : selectedVariables.length === 0 ? (
                    <p className="mt-3 text-sm text-muted-foreground">
                      These revisions do not enable test values.
                    </p>
                  ) : (
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      {selectedVariables.map(({ id, variable }) =>
                        variable ? (
                          <div key={id}>
                            <Label htmlFor={`test-value-${id}`}>
                              @{variable.name}
                            </Label>
                            {variable.description ? (
                              <p className="text-xs text-muted-foreground">
                                {variable.description}
                              </p>
                            ) : null}
                            {variable.valueType === "json" ? (
                              <Textarea
                                id={`test-value-${id}`}
                                value={valueInputs[id] ?? ""}
                                placeholder="Valid JSON"
                                onChange={(event) => {
                                  const raw = event.target.value;
                                  setValueInputs((current) => ({
                                    ...current,
                                    [id]: raw,
                                  }));
                                  clearActiveTest(
                                    "Test values changed. Start a fresh private test.",
                                  );
                                }}
                              />
                            ) : (
                              <Input
                                id={`test-value-${id}`}
                                value={valueInputs[id] ?? ""}
                                onChange={(event) => {
                                  setValueInputs((current) => ({
                                    ...current,
                                    [id]: event.target.value,
                                  }));
                                  clearActiveTest(
                                    "Test values changed. Start a fresh private test.",
                                  );
                                }}
                              />
                            )}
                          </div>
                        ) : null,
                      )}
                    </div>
                  )}
                </div>
              </DialogContent>
            </Dialog>
            <Dialog open={evalsOpen} onOpenChange={setEvalsOpen}>
              <DialogContent className="max-h-[calc(100vh-2rem)] max-w-3xl overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>Evals</DialogTitle>
                  <DialogDescription>
                    Run saved cases against the selected revision{mode === "compare" ? "s" : ""}.{" "}
                    <Link className="underline" href={evalsHref}>Open Evals</Link>
                  </DialogDescription>
                </DialogHeader>
                <section>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void runEvals()}
                      disabled={
                        !availableSelectedCaseIds.length ||
                        Boolean(blockingContextError) ||
                        isRunningEvals ||
                        evalRun?.state === "running"
                      }
                    >
                      {isRunningEvals || evalRun?.state === "running" ? (
                        <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                      ) : null}
                      {isRunningEvals || evalRun?.state === "running"
                        ? "Running…"
                        : "Run evals"}
                    </Button>
                  </div>
                  {agentCases.length ? (
                    <fieldset className="mt-3 space-y-2">
                      <legend className="text-sm font-medium">
                        Select cases
                      </legend>
                      {agentCases.map((item) => (
                        <label
                          key={item.id}
                          className="flex items-center gap-2 text-sm"
                        >
                          <input
                            type="checkbox"
                            checked={availableSelectedCaseIds.includes(item.id)}
                            onChange={(event) =>
                              setSelectedCaseIds((current) =>
                                event.target.checked
                                  ? [...current, item.id]
                                  : current.filter((id) => id !== item.id),
                              )
                            }
                          />
                          {item.name}
                        </label>
                      ))}
                    </fieldset>
                  ) : (
                    <p className="mt-3 text-sm text-muted-foreground">
                      {cases.length ? (
                        <>
                          No eval cases belong to this agent.{" "}
                          <Link className="underline" href={evalsHref}>
                            Open Evals to author one
                          </Link>
                          .
                        </>
                      ) : (
                        <>
                          No eval cases exist yet.{" "}
                          <Link className="underline" href={evalsHref}>
                            Open Evals to create one
                          </Link>
                          .
                        </>
                      )}
                    </p>
                  )}
                  {evalRun ? (
                    <div className="mt-3 overflow-x-auto">
                      <p
                        aria-live="polite"
                        className="mb-2 text-sm text-muted-foreground"
                      >
                        {evalRun.state === "running"
                          ? "Revision evals are running…"
                          : `Eval ${executionStateLabel[evalRun.state]}`}
                      </p>
                      <table className="min-w-full text-left text-sm">
                        <thead>
                          <tr className="border-b">
                            <th className="p-2 font-medium">Case</th>
                            {selected.map((revisionId) => (
                              <th
                                key={revisionId}
                                className="min-w-48 p-2 font-medium"
                              >
                                {(() => {
                                  const evalRevision = evalByRevision.get(revisionId)?.revision;
                                  const revision = revisions.find(
                                    (candidate) => candidate.id === revisionId,
                                  );
                                  return evalRevision
                                    ? evalRevision.label
                                    : revision
                                      ? revisionTriggerLabel(revision)
                                      : "Version unavailable";
                                })()}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {availableSelectedCaseIds.map((id) => (
                            <tr key={id} className="border-b last:border-0">
                              <th className="p-2 font-medium">
                                {agentCases.find((item) => item.id === id)
                                  ?.name ?? id}
                              </th>
                              {selected.map((revisionId) => {
                                const side = evalByRevision.get(revisionId);
                                const result = side?.cases.find(
                                  (item) => item.caseId === id,
                                );
                                const retryKey = `${revisionId}:${id}`;
                                const retryable = result?.state === "failed";
                                return (
                                  <td
                                    key={revisionId}
                                    className="p-2 align-top"
                                  >
                                    <div className="space-y-1">
                                      <Badge
                                        variant={
                                          result?.outcome === "partial"
                                            ? "secondary"
                                            : "outline"
                                        }
                                        className={
                                          result?.outcome === "fail"
                                            ? "border-destructive/40 bg-destructive/10 text-destructive"
                                            : undefined
                                        }
                                      >
                                        {result
                                          ? outcomeLabel[result.outcome]
                                          : "Not run"}
                                      </Badge>
                                      <p className="text-xs text-muted-foreground">
                                        {result
                                          ? `${executionStateLabel[result.state]} · ${evidenceLabel[side?.evidenceState ?? "comparability_unknown"]}`
                                          : "No result for this revision"}
                                      </p>
                                      {retryable ? (
                                        <Button
                                          size="sm"
                                          variant="link"
                                          className="h-auto p-0"
                                          disabled={Boolean(retryingEvalCase)}
                                          onClick={() =>
                                            void retryEvalCase(revisionId, id)
                                          }
                                        >
                                          {retryingEvalCase === retryKey ? (
                                            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                                          ) : null}
                                          Retry case
                                        </Button>
                                      ) : null}
                                    </div>
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                </section>
              </DialogContent>
            </Dialog>
          </>
        )}
      </div>
    </>
  );
}
