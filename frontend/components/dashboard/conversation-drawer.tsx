'use client'

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Bug, Check, Copy, Search, Workflow, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { CopyValueField } from '@/components/ui/copy-value-field'
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer'
import { LogoSpinner } from '@/components/ui/spinner'
import { ActivityTraceDetail } from './activity-trace-detail'
import { ActivityTraceGraph } from './activity-trace-graph'
import { TurnFlowOverlay } from './turn-flow-overlay'
import { ChatMessageThread } from './chat-message-thread'
import { OperatorActionBar } from './operator-action-bar'
import { HistoryDocumentDialog } from '@/components/dashboard/history/history-document-dialog'
import { MetadataBadges } from '@/components/dashboard/shared/metadata-badges'
import {
  useHistoryDetailState,
  useHistoryDocumentDialogState,
} from '@/components/dashboard/history/use-chat-history-state'
import type { SelectedHistoryItem } from '@/components/dashboard/history/history-list'
import {
  type ChatConversationTurn,
  type ContactHistoryDetail,
  type DocumentSearchResponse,
  type PendingApprovalDecision,
  type TurnTraceEnvelope,
} from '@/lib/api'
import { hitlApi } from '@/lib/api-hitl'
import { useConversationTail } from '@/hooks/use-conversation-tail'
import {
  formatConversationChannelContextDetails,
  formatConversationSource,
  getConversationSourceBadge,
} from '@/lib/history-source'
import {
  type DiagnosticPresentation,
  presentActivityOutcome,
  presentRunParameters,
} from '@/lib/activity-diagnostics'
import { useSkillCatalog } from '@/lib/skill-catalog'
import { computeRoutineThreadMarkers } from '@/lib/routine-thread-grouping'
import { useRoutineCatalog } from '@/lib/routine-catalog'
import { clarificationDecisionFromSpine, routineTurnSignalFromSpine } from '@/lib/turn-trace'

const toneStyles: Record<DiagnosticPresentation['tone'], string> = {
  neutral: 'border-border/70 bg-background/60',
  ok: 'border-emerald-500/30 bg-emerald-500/10',
  warning: 'border-amber-500/30 bg-amber-500/10',
  error: 'border-destructive/30 bg-destructive/10',
}

function CompactIdField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(value)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs transition hover:bg-muted/50"
      title={`Copy ${label} ID: ${value}`}
    >
      <span className="shrink-0 font-medium text-muted-foreground">{label}</span>
      <code className="min-w-0 truncate font-mono text-foreground">{value}</code>
      {copied ? <Check className="h-3 w-3 shrink-0 text-green-500" /> : <Copy className="h-3 w-3 shrink-0 text-muted-foreground" />}
    </button>
  )
}

const contactStatusLabels: Record<ContactHistoryDetail['status'], string> = {
  pending: 'Pending',
  delivering: 'Delivering',
  delivered: 'Delivered',
  failed: 'Failed',
}

function ContactRequestPanel({
  contact,
  className,
}: {
  contact: ContactHistoryDetail
  className?: string
}) {
  return (
    <div className={className}>
      <div className="rounded-lg border border-border/70 bg-background/70 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-foreground">Contact request</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {contactStatusLabels[contact.status]} - {contact.triggerSource.replaceAll('_', ' ')}
            </p>
          </div>
          <CopyValueField
            label="Email:"
            value={contact.userEmail}
            copyValue={contact.userEmail}
            ariaLabel="Copy contact email"
            compact
            fitContent
            inlineLabel
          />
        </div>
        <div className="mt-4">
          <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">Message</p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{contact.message}</p>
        </div>
        {contact.triggerReason || contact.finalDeliveryError ? (
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {contact.triggerReason ? (
              <div>
                <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">Trigger reason</p>
                <p className="mt-1 text-sm text-muted-foreground">{contact.triggerReason}</p>
              </div>
            ) : null}
            {contact.finalDeliveryError ? (
              <div>
                <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">Delivery error</p>
                <p className="mt-1 text-sm text-destructive">{contact.finalDeliveryError}</p>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function DiagnosticPresentationSection({
  label,
  presentation,
}: {
  label: string
  presentation: DiagnosticPresentation
}) {
  return (
    <section className={`rounded-lg border p-3 ${toneStyles[presentation.tone]}`}>
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-base font-medium text-foreground">{presentation.title}</p>
      <p className="mt-1 text-sm leading-6 text-muted-foreground">{presentation.summary}</p>
      {presentation.facts.length ? (
        <dl className="mt-3 grid gap-x-4 gap-y-2 sm:grid-cols-2">
          {presentation.facts.map((fact) => (
            <div key={`${label}-${fact.label}`} className="min-w-0">
              <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{fact.label}</dt>
              <dd className="mt-0.5 break-words text-sm text-foreground">{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  )
}

function ChatDiagnosticsPanel({
  selectedMessage,
  diagnosticsMessage,
  activeEnvelope,
  activityTrace,
  routineNamesById,
  selectedStageId,
  onSelectLeafStage,
}: {
  selectedMessage: ChatConversationTurn | null
  diagnosticsMessage: ChatConversationTurn | null
  activeEnvelope?: TurnTraceEnvelope
  activityTrace?: NonNullable<ChatConversationTurn['debug']>['activityTrace']
  routineNamesById?: ReadonlyMap<string, string>
  selectedStageId?: string
  onSelectLeafStage: (stageId: string) => void
}) {
  if (!selectedMessage) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
        Select a message to inspect diagnostics.
      </div>
    )
  }

  const diagnosticsDebug =
    diagnosticsMessage?.role === 'assistant' ? diagnosticsMessage.debug : undefined
  const diagnosticsMetadata = diagnosticsMessage && typeof diagnosticsMessage === 'object'
    ? diagnosticsMessage as ChatConversationTurn & { metadataJson?: Record<string, unknown>; metadata_json?: Record<string, unknown> }
    : null
  const visitorContext = diagnosticsMetadata?.metadataJson?.contextVariables ?? diagnosticsMetadata?.metadata_json?.contextVariables
  const resolvedActivityTrace = activityTrace ?? diagnosticsDebug?.activityTrace
  // The outcome summary reads from the turn spine — which knows a routine drove
  // the reply or that a clarification was asked — so it can be specific instead
  // of flattening everything that isn't retrieval to a "direct reply".
  const spine = diagnosticsDebug?.turnTrace?.spine
  const routineSignal = routineTurnSignalFromSpine(spine)
  const routineName = routineSignal ? routineNamesById?.get(routineSignal.routineId) : undefined
  const outcomePresentation = presentActivityOutcome({
    trace: resolvedActivityTrace,
    route: diagnosticsDebug?.route,
    answerOutcome: diagnosticsDebug?.answerOutcome,
    routine: routineSignal ? { name: routineName, completed: routineSignal.completed } : undefined,
    clarificationAsked: clarificationDecisionFromSpine(spine) === 'asked',
  })
  const runParameters = presentRunParameters(resolvedActivityTrace)

  return (
    <div className="space-y-4">
      <CompactIdField label="Message" value={selectedMessage.id} />

      {diagnosticsDebug?.errorMessage ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {diagnosticsDebug.errorMessage}
        </div>
      ) : null}

      <DiagnosticPresentationSection label="Outcome summary" presentation={outcomePresentation} />

      {runParameters ? (
        <DiagnosticPresentationSection label="Run parameters" presentation={runParameters} />
      ) : null}

      {/* The turn flow opens full-screen from the header (envelope turns). Legacy
          turns without an envelope keep the inline flat activity trace explorer. */}
      {activeEnvelope ? (
        <p className="text-xs text-muted-foreground">
          Open <span className="font-medium text-foreground">Flow</span> to explore this turn as a graph —
          inputs flow into the engine, which selects a skill and its retrieval path, leading to the outcome.
        </p>
      ) : (
        <div className="grid grid-cols-[minmax(200px,260px)_1fr] gap-4">
          <div className="sticky top-0 self-start overflow-y-auto rounded-lg border border-border/50 bg-muted/20 p-2">
            {resolvedActivityTrace ? (
              <ActivityTraceGraph
                activityTrace={resolvedActivityTrace}
                selectedStageId={selectedStageId ?? resolvedActivityTrace.stages[0]?.stageId ?? ''}
                onSelectStage={onSelectLeafStage}
              />
            ) : (
              <div className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
                Activity trace unavailable for this turn.
              </div>
            )}
          </div>
          <div className="min-h-0">
            <ActivityTraceDetail
              activityTrace={resolvedActivityTrace}
              selectedStageId={selectedStageId}
              visitorContext={visitorContext}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function SearchDiagnosticsPanel({
  search,
  selectedStageId,
  graphPane,
}: {
  search: DocumentSearchResponse
  selectedStageId?: string
  graphPane: ReactNode
}) {
  if (!search.activityTrace) {
    return (
      <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
        Diagnostics are unavailable for this search.
      </div>
    )
  }

  const outcomePresentation = presentActivityOutcome({ trace: search.activityTrace })
  const runParameters = presentRunParameters(search.activityTrace)

  return (
    <div className="space-y-4">
      <DiagnosticPresentationSection label="Outcome summary" presentation={outcomePresentation} />
      {runParameters ? (
        <DiagnosticPresentationSection label="Run parameters" presentation={runParameters} />
      ) : null}
      <div className="grid grid-cols-[minmax(180px,220px)_1fr] gap-4">
        <div className="sticky top-0 self-start overflow-y-auto rounded-lg border border-border/50 bg-muted/20 p-2">
          {graphPane}
        </div>
        <div className="min-h-0">
          <ActivityTraceDetail
            activityTrace={search.activityTrace}
            selectedStageId={selectedStageId}
          />
        </div>
      </div>
    </div>
  )
}

export interface ConversationDrawerProps {
  selectedItem: SelectedHistoryItem
  onSelectedItemChange: (item: SelectedHistoryItem) => void
  anchorMessageId?: string | null
  /**
   * Optional callback fired after the drawer closes (either via user action or
   * because the conversation was not found). Use this to sync URL state.
   */
  onAfterClose?: () => void
  /**
   * Optional callback fired after operator actions mutate conversation ownership
   * or pending approvals. Use this to sync parent inbox lists.
   */
  onOperatorChanged?: () => Promise<void> | void
  /**
   * Optional pending approvals supplied by a parent that already owns the inbox
   * refresh. When present, the drawer derives its conversation-scoped approvals
   * from this list instead of issuing its own pending-decision fetch.
   */
  pendingDecisions?: PendingApprovalDecision[]
  /**
   * Builds a dashboard link to a routine version for the diagnostics routine
   * band. Supplied by call sites that own the route state; omitted where routine
   * deep-links don't apply.
   */
  buildRoutineHref?: (agentId: string, routineId: string) => string
}

export function ConversationDrawer({
  selectedItem,
  onSelectedItemChange,
  anchorMessageId,
  onAfterClose,
  onOperatorChanged,
  pendingDecisions,
  buildRoutineHref,
}: ConversationDrawerProps) {
  const selectedChatConversationId = selectedItem?.kind === 'chat' ? selectedItem.id : null
  const skillCatalog = useSkillCatalog(selectedItem?.id ?? null)
  const handleItemNotFound = useCallback(() => {
    onAfterClose?.()
  }, [onAfterClose])
  const conversationTail = useConversationTail({
    conversationId: selectedChatConversationId ?? '',
    enabled: selectedChatConversationId !== null,
    intervalMs: 1000,
  })

  const {
    conversationDetail,
    searchDetail,
    contactDetail,
    isDetailLoading,
    detailError,
    selectedThreadMessage,
    selectedThreadMessageId,
    selectedDiagnosticsAssistantMessage,
    activeTrace,
    activeEnvelope,
    activeInitialStageId,
    selectedStageId,
    setSelectedStageId,
    showGraph,
    setShowGraph,
    refetchDetail,
    handleSelectThreadMessage,
    loadOlderMessages,
    effectiveConversationMessages,
  } = useHistoryDetailState({
    selectedItem,
    setSelectedItem: onSelectedItemChange,
    onItemNotFound: handleItemNotFound,
    anchorMessageId,
    additionalConversationMessages: conversationTail.messages,
  })

  const {
    isDocumentDialogOpen,
    isDocumentLoading,
    documentDetail,
    documentError,
    handleOpenCitation,
    handleDocumentDialogOpenChange,
  } = useHistoryDocumentDialogState()

  const [flowOpen, setFlowOpen] = useState(false)
  const [pendingDecisionState, setPendingDecisionState] = useState<{
    conversationId: string | null
    decisions: PendingApprovalDecision[]
  }>({ conversationId: null, decisions: [] })
  const [pendingDecisionError, setPendingDecisionError] = useState<string | null>(null)

  const loadPendingDecisions = useCallback(async () => {
    if (pendingDecisions) {
      return
    }

    if (!selectedChatConversationId) {
      setPendingDecisionState({ conversationId: null, decisions: [] })
      setPendingDecisionError(null)
      return
    }

    try {
      const response = await hitlApi.listPendingDecisions()
      setPendingDecisionState({
        conversationId: selectedChatConversationId,
        decisions: response.decisions.filter((decision) => decision.conversationId === selectedChatConversationId),
      })
      setPendingDecisionError(null)
    } catch {
      setPendingDecisionState({ conversationId: selectedChatConversationId, decisions: [] })
      setPendingDecisionError('Failed to refresh approval requests.')
    }
  }, [pendingDecisions, selectedChatConversationId])

  useEffect(() => {
    if (pendingDecisions) {
      return
    }

    if (!selectedChatConversationId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Synchronously clears conversation-scoped approvals when the chat drawer closes.
      setPendingDecisionState({ conversationId: null, decisions: [] })
      setPendingDecisionError(null)
      return
    }

    let isActive = true
    setPendingDecisionState({ conversationId: selectedChatConversationId, decisions: [] })
    setPendingDecisionError(null)

    const load = async () => {
      try {
        const response = await hitlApi.listPendingDecisions()
        if (!isActive) {
          return
        }
        setPendingDecisionState({
          conversationId: selectedChatConversationId,
          decisions: response.decisions.filter((decision) => decision.conversationId === selectedChatConversationId),
        })
      } catch {
        if (isActive) {
          setPendingDecisionState({ conversationId: selectedChatConversationId, decisions: [] })
          setPendingDecisionError('Failed to load approval requests.')
        }
      }
    }

    void load()

    return () => {
      isActive = false
    }
  }, [pendingDecisions, selectedChatConversationId])

  const handleOperatorChanged = useCallback(async () => {
    if (pendingDecisions) {
      await Promise.all([
        refetchDetail(),
        onOperatorChanged?.(),
      ])
      return
    }

    await Promise.all([
      refetchDetail(),
      loadPendingDecisions(),
      onOperatorChanged?.(),
    ])
  }, [loadPendingDecisions, onOperatorChanged, pendingDecisions, refetchDetail])

  const renderedConversationMessages = effectiveConversationMessages

  const tailOwnershipIsCurrent =
    !conversationDetail?.ownership ||
    !conversationTail.ownership ||
    conversationTail.ownership.version >= conversationDetail.ownership.version
  const actionBarOwnership = conversationTail.hasPolled && tailOwnershipIsCurrent
    ? conversationTail.ownership
    : conversationDetail?.ownership
  const activePendingDecisions = pendingDecisions
    ? pendingDecisions.filter((decision) => decision.conversationId === selectedChatConversationId)
    : pendingDecisionState.conversationId === selectedChatConversationId
      ? pendingDecisionState.decisions.filter((decision) => decision.conversationId === selectedChatConversationId)
      : []

  // Mark which turns a routine drove so the conversation thread can band the
  // routine's span (start chip, paused/ended marker). The signal lives on each
  // assistant turn's spine trace, which history always carries for diagnostics.
  const routineMarkers = useMemo(
    () =>
      renderedConversationMessages.length > 0
        ? computeRoutineThreadMarkers(
            renderedConversationMessages.map((message) => ({
              role: message.role,
              routine:
                message.role === 'assistant'
                  ? routineTurnSignalFromSpine(message.debug?.turnTrace?.spine)
                  : undefined,
            })),
          )
        : undefined,
    [renderedConversationMessages],
  )

  // The trace carries only the routine id; join its readable name from the
  // agent's routine catalog (fetched only when the conversation has a routine).
  const conversationHasRoutines = routineMarkers?.some((marker) => marker.groupKey !== null) ?? false
  const routineNamesById = useRoutineCatalog(
    conversationHasRoutines ? conversationDetail?.agentId ?? null : null,
  )
  // Only authored routines we can resolve a name for get a deep link — built-in
  // routines (and superseded versions no longer in the catalog) stay plain text.
  const conversationAgentId = conversationDetail?.agentId ?? null
  const namedRoutineMarkers = useMemo(
    () =>
      routineMarkers?.map((marker) => {
        if (!marker.routineId) {
          return marker
        }
        const routineName = routineNamesById.get(marker.routineId)
        const routineHref =
          routineName && conversationAgentId && buildRoutineHref
            ? buildRoutineHref(conversationAgentId, marker.routineId)
            : undefined
        return { ...marker, routineName, routineHref }
      }),
    [routineMarkers, routineNamesById, conversationAgentId, buildRoutineHref],
  )

  return (
    <>
      <Drawer
        open={selectedItem !== null}
        onOpenChange={(open) => {
          if (!open) {
            onSelectedItemChange(null)
            setShowGraph(false)
            setFlowOpen(false)
            onAfterClose?.()
          }
        }}
        direction="right"
        handleOnly
      >
        <DrawerContent
          className={`h-full !w-[96vw] !max-w-[96vw] transition-[width,max-width] duration-300 ease-in-out ${
            showGraph
              ? 'lg:!w-[94vw] lg:!max-w-[94vw]'
              : 'lg:!w-[56vw] lg:!max-w-[56vw]'
          }`}
        >
          <DrawerHeader className="border-b border-border py-3">
            <div className="flex items-center justify-between gap-4">
              <DrawerTitle className="sr-only">
                {selectedItem?.kind === 'chat'
                  ? 'Conversation details'
                  : selectedItem?.kind === 'contact'
                    ? 'Contact request details'
                    : 'Search details'}
              </DrawerTitle>
              <div className="flex min-w-0 items-center gap-3">
                {selectedItem ? (
                  <CompactIdField
                    label={selectedItem.kind === 'chat' ? 'Conversation' : selectedItem.kind === 'contact' ? 'Contact' : 'Search'}
                    value={selectedItem.id}
                  />
                ) : null}
                {(selectedItem?.kind === 'chat' || selectedItem?.kind === 'contact') && conversationDetail ? (() => {
                  const source = formatConversationSource(conversationDetail)
                  const sourceBadge = getConversationSourceBadge(conversationDetail)
                  const contextDetails = formatConversationChannelContextDetails(conversationDetail.channelContext)
                  return source ? (
                    <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                      {sourceBadge ? (
                        <span className={`${sourceBadge.className} shrink-0 font-medium`}>{sourceBadge.label}</span>
                      ) : null}
                      <span className="shrink-0 rounded-full bg-muted px-2.5 py-0.5">{source}</span>
                      {contextDetails.length > 0 ? (
                        <span className="min-w-0 truncate">{contextDetails.join(' · ')}</span>
                      ) : null}
                    </div>
                  ) : null
                })() : null}
              </div>
              <div className="flex items-center gap-2">
                {showGraph && activeEnvelope ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    onClick={() => setFlowOpen(true)}
                  >
                    <Workflow className="h-3.5 w-3.5" />
                    Flow
                  </Button>
                ) : null}
                {activeTrace || activeEnvelope ? (
                  <Button
                    type="button"
                    size="sm"
                    variant={showGraph ? 'secondary' : 'outline'}
                    className="gap-1.5"
                    onClick={() => {
                      if (showGraph) {
                        setShowGraph(false)
                        setFlowOpen(false)
                        setSelectedStageId(activeInitialStageId)
                      } else {
                        setShowGraph(true)
                      }
                    }}
                  >
                    <Bug className="h-3.5 w-3.5" />
                    {showGraph ? 'Close' : 'Debug'}
                  </Button>
                ) : null}
                <DrawerClose
                  aria-label="Close details panel"
                  className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground"
                >
                  <span className="sr-only">Close details panel</span>
                  <X className="h-4 w-4" />
                </DrawerClose>
              </div>
            </div>
            <DrawerDescription className="sr-only">Conversation details panel</DrawerDescription>
          </DrawerHeader>

          <div className="min-h-0 flex-1 overflow-hidden p-4">
            {isDetailLoading ? (
              <div className="flex h-full items-center justify-center">
                <LogoSpinner imageClassName="h-7 w-7" />
              </div>
            ) : detailError ? (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
                {detailError}
              </div>
            ) : (selectedItem?.kind === 'chat' || selectedItem?.kind === 'contact') && conversationDetail ? (
              <div className={`grid h-full min-h-0 gap-4 ${showGraph ? 'xl:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.2fr)]' : ''}`}>
                <div className="min-h-0 overflow-y-auto pr-1">
                  {selectedItem.kind === 'contact' && contactDetail ? (
                    <ContactRequestPanel contact={contactDetail.contact} className="mb-4" />
                  ) : null}
                  {conversationDetail.hasOlderMessages ? (
                    <div className="mb-3 flex justify-center">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={isDetailLoading || !conversationDetail.nextCursor}
                        onClick={() => void loadOlderMessages()}
                      >
                        Load older messages
                      </Button>
                    </div>
                  ) : null}
                  <ChatMessageThread
                    messages={renderedConversationMessages.map((message) =>
                      // History messages already have a persisted DB id; the
                      // ChatMessageThread component derives `assistantMessageId`
                      // from `persistedAssistantMessageId`, which is only set
                      // by the live-streaming flow. Mirror it from `id` here so
                      // feedback + send-to-eval render on historical turns.
                      message.role === 'assistant'
                        ? { ...message, persistedAssistantMessageId: message.id }
                        : message
                    )}
                    onOpenDocument={handleOpenCitation}
                    onMessageSelect={handleSelectThreadMessage}
                    selectedMessageId={selectedThreadMessageId ?? undefined}
                    conversationId={selectedItem?.kind === 'chat' ? selectedItem.id : undefined}
                    evalCaptureEnabled={selectedItem?.kind === 'chat'}
                    analyticsSurface="history"
                    skillCatalog={skillCatalog}
                    routineMarkers={namedRoutineMarkers}
                  />
                  {selectedItem.kind === 'chat' ? (
                    <>
                      <OperatorActionBar
                        conversationId={selectedItem.id}
                        ownership={actionBarOwnership}
                        pendingDecisions={activePendingDecisions}
                        onChanged={handleOperatorChanged}
                      />
                      {pendingDecisionError ? (
                        <p className="px-4 pb-4 text-sm text-destructive" role="status">
                          {pendingDecisionError}
                        </p>
                      ) : null}
                    </>
                  ) : null}
                </div>

                {showGraph ? (
                  <div className="min-h-0 overflow-y-auto rounded-xl border border-border/70 bg-background/50 p-4">
                    <ChatDiagnosticsPanel
                      selectedMessage={selectedThreadMessage}
                      diagnosticsMessage={selectedDiagnosticsAssistantMessage}
                      activeEnvelope={activeEnvelope}
                      activityTrace={activeTrace}
                      routineNamesById={routineNamesById}
                      selectedStageId={selectedStageId}
                      onSelectLeafStage={setSelectedStageId}
                    />
                  </div>
                ) : null}
              </div>
            ) : selectedItem?.kind === 'search' && searchDetail ? (
              <div className={`grid h-full min-h-0 gap-4 ${showGraph ? 'xl:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.2fr)]' : ''}`}>
                <div className="min-h-0 overflow-y-auto pr-1">
                  <div className="space-y-4">
                    <div>
                      <p className="text-lg font-medium text-foreground">{searchDetail.query}</p>
                      <p className="text-sm text-muted-foreground">
                        {searchDetail.resultCount} document{searchDetail.resultCount === 1 ? '' : 's'} retrieved
                      </p>
                    </div>

                    {searchDetail.results.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
                        No matching documents were stored for this search.
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {searchDetail.results.map((result) => (
                          <button
                            key={`${searchDetail.searchId}-${result.documentId}`}
                            type="button"
                            onClick={() => void handleOpenCitation(result.documentId)}
                            disabled={!result.actions.some((action) => action.type === 'open_document' && action.status === 'available')}
                            className="w-full rounded-lg border border-border bg-card p-4 text-left transition hover:border-primary/40 hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <div className="space-y-2">
                              <div className="flex items-center gap-2">
                                <Search className="h-4 w-4 text-muted-foreground" />
                                <p className="text-sm font-medium text-foreground">{result.title}</p>
                              </div>
                              <p className="text-xs text-muted-foreground">
                                Rank {result.rank} • Score {result.score.toFixed(3)}
                              </p>
                              <MetadataBadges metadata={result.metadata} className="" />
                              {result.matchEvidence.map((evidence) => (
                                <p key={evidence} className="text-sm text-muted-foreground">
                                  {evidence}
                                </p>
                              ))}
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {showGraph && searchDetail.activityTrace ? (
                  <div className="min-h-0 overflow-y-auto rounded-xl border border-border/70 bg-background/50 p-4">
                    <SearchDiagnosticsPanel
                      search={searchDetail}
                      selectedStageId={selectedStageId}
                      graphPane={
                        <ActivityTraceGraph
                          activityTrace={searchDetail.activityTrace}
                          selectedStageId={selectedStageId ?? searchDetail.activityTrace.stages[0]?.stageId ?? ''}
                          onSelectStage={setSelectedStageId}
                        />
                      }
                    />
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Select an activity entry to inspect it.
              </div>
            )}
          </div>

          {showGraph && activeEnvelope ? (
            <TurnFlowOverlay
              key={activeEnvelope.spine.traceId}
              open={flowOpen}
              envelope={activeEnvelope}
              leafTrace={activeTrace}
              onClose={() => setFlowOpen(false)}
              // Pass the drawer's already-authorized conversation messages so the
              // overlay can show user/history/answer text without the trace
              // envelope embedding raw content.
              messages={renderedConversationMessages}
              assistantMessageId={selectedDiagnosticsAssistantMessage?.id}
            />
          ) : null}
        </DrawerContent>
      </Drawer>

      <HistoryDocumentDialog
        open={isDocumentDialogOpen}
        isLoading={isDocumentLoading}
        error={documentError}
        document={documentDetail}
        onOpenChange={handleDocumentDialogOpenChange}
      />
    </>
  )
}
