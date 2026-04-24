'use client'

import { useState } from 'react'
import { FileText, LoaderCircle, MessageSquareText, Rocket, Sparkles } from 'lucide-react'
import { useRouter } from 'next/navigation'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { useWorkspace } from '@/lib/workspace-context'
import { buildDashboardHref } from '@/lib/dashboard-routes'
import { SAMPLE_QUESTIONS, type WorkspaceOnboardingState } from '@/lib/onboarding'
import { useChatSession } from '@/lib/chat-context'

interface FirstRunExperienceProps {
  accountId: string
  onboarding: WorkspaceOnboardingState
}

const stepState = (active: boolean, done: boolean) => {
  if (done) return 'default' as const
  return active ? 'secondary' : 'outline'
}

export function FirstRunExperience({ accountId, onboarding }: FirstRunExperienceProps) {
  const router = useRouter()
  const { activeWorkspace, activeWorkspaceId, renameWorkspace } = useWorkspace()
  const { sendMessage, isLoading: isChatLoading } = useChatSession(activeWorkspaceId ?? accountId)
  const [workspaceName, setWorkspaceName] = useState(activeWorkspace?.name ?? '')
  const [isSavingName, setIsSavingName] = useState(false)

  const isProcessing = onboarding.hasPendingDocuments
  const isReadyForQuestions = onboarding.hasReadyDocuments && !onboarding.hasPendingDocuments
  const currentStep = isReadyForQuestions ? 4 : isProcessing || onboarding.hasDocuments ? 3 : 2
  const progressValue = isReadyForQuestions ? 100 : isProcessing ? 72 : 32

  const handleRename = async () => {
    if (!activeWorkspace) {
      return
    }

    const trimmed = workspaceName.trim()
    if (!trimmed || trimmed === activeWorkspace.name) {
      return
    }

    setIsSavingName(true)
    try {
      await renameWorkspace(activeWorkspace.id, trimmed)
    } finally {
      setIsSavingName(false)
    }
  }

  const handleUploadDocs = () => {
    onboarding.markActive()
    router.push(buildDashboardHref(accountId, {
      section: 'documents',
      workspaceId: activeWorkspaceId ?? undefined,
      workspacePublicRouteKey: activeWorkspace?.publicRouteKey,
    }))
  }

  const handleAskQuestion = async (question: string) => {
    const didSend = await sendMessage(question)
    if (didSend) {
      onboarding.markCompleted()
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-[radial-gradient(circle_at_top,_rgba(245,158,11,0.14),_transparent_30%),linear-gradient(to_bottom,_transparent,_rgba(15,23,42,0.04))]">
      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-8">
        <div className="flex flex-col gap-4 rounded-3xl border border-border/70 bg-card/95 p-6 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-3">
              <Badge variant="secondary" className="gap-1">
                <Sparkles className="h-3 w-3" />
                First-run flow
              </Badge>
              <div className="space-y-2">
                <h1 className="text-3xl font-semibold tracking-tight text-foreground">
                  Reach your first grounded answer quickly
                </h1>
                <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                  Your first workspace already exists. Load a small knowledge base, wait for processing,
                  and ask one question before touching tokens or advanced settings.
                </p>
              </div>
            </div>
            <div className="min-w-[220px] space-y-2 rounded-2xl border border-border/80 bg-background/70 p-4">
              <div className="flex items-center justify-between text-xs uppercase tracking-[0.2em] text-muted-foreground">
                <span>Progress</span>
                <span>Step {currentStep} of 4</span>
              </div>
              <Progress value={progressValue} className="h-2" />
              <p className="text-sm text-muted-foreground">
                {isReadyForQuestions
                  ? 'Your docs are ready. Ask the first question now.'
                  : isProcessing
                    ? 'Suggested starter documents are processing. Radioso will unlock suggested questions next.'
                    : 'Radioso is preparing starter documents for this empty workspace.'}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Badge variant="default">1. Workspace</Badge>
            <Badge variant={stepState(currentStep === 2, onboarding.hasDocuments || isProcessing || isReadyForQuestions)}>
              2. Content
            </Badge>
            <Badge variant={stepState(currentStep === 3, isProcessing || isReadyForQuestions)}>
              3. Processing
            </Badge>
            <Badge variant={stepState(currentStep === 4, isReadyForQuestions)}>4. Ask</Badge>
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(320px,1fr)]">
          <Card className="border-border/70">
            <CardHeader>
              <CardTitle>Step 1. Optional workspace rename</CardTitle>
              <CardDescription>
                Keep the default name or make it more specific before you start.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Input
                  value={workspaceName}
                  onChange={(event) => setWorkspaceName(event.target.value)}
                  placeholder="Workspace name"
                  maxLength={100}
                />
                <Button
                  variant="outline"
                  onClick={() => void handleRename()}
                  disabled={isSavingName || !activeWorkspace || workspaceName.trim() === activeWorkspace.name}
                >
                  {isSavingName ? 'Saving...' : 'Save'}
                </Button>
              </div>

              <Separator />

              <div className="space-y-4">
                <div>
                  <h2 className="font-medium text-foreground">Step 2. Starter knowledge base</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    This guided first-run workspace is seeded with a short starter knowledge base so the first question works immediately.
                  </p>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="rounded-2xl border border-border bg-background p-5 text-left">
                    <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
                      <LoaderCircle className={`h-5 w-5 text-primary ${onboarding.isImportingSampleDocs || isProcessing ? 'animate-spin' : ''}`} />
                    </div>
                    <h3 className="font-medium text-foreground">Suggested starter docs</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Radioso loads a short set of onboarding documents covering setup, architecture, and configuration.
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={handleUploadDocs}
                    className="rounded-2xl border border-border bg-background p-5 text-left transition-colors hover:border-primary/40 hover:bg-accent/30"
                  >
                    <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
                      <FileText className="h-5 w-5 text-primary" />
                    </div>
                    <h3 className="font-medium text-foreground">Upload my docs instead</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Open Documents and import a file or add markdown from your own knowledge base at any time.
                    </p>
                  </button>
                </div>
              </div>

              <Separator />

              <div className="space-y-4">
                <div>
                  <h2 className="font-medium text-foreground">Step 3. Wait for ingestion</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Radioso is preparing chunks and retrieval data before chat begins.
                  </p>
                </div>

                <div className="rounded-2xl border border-border bg-background/70 p-4">
                  {isProcessing ? (
                    <div className="flex items-center gap-3 text-sm text-muted-foreground">
                      <LoaderCircle className="h-4 w-4 animate-spin text-primary" />
                      Processing {onboarding.documents.length} document{onboarding.documents.length === 1 ? '' : 's'}.
                    </div>
                  ) : onboarding.hasReadyDocuments ? (
                    <div className="flex items-center gap-3 text-sm text-foreground">
                      <Rocket className="h-4 w-4 text-primary" />
                      Your workspace is ready for the first question.
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground">
                      No documents yet. Start with the guided starter docs or upload your own.
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/70">
            <CardHeader>
              <CardTitle>Step 4. Suggested first questions</CardTitle>
              <CardDescription>
                Use one of these once the workspace is ready. They are tuned for the built-in sample docs.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {SAMPLE_QUESTIONS.map((question) => (
                <Button
                  key={question}
                  variant="outline"
                  className="h-auto w-full justify-start whitespace-normal px-4 py-3 text-left"
                  disabled={!isReadyForQuestions || isChatLoading}
                  onClick={() => void handleAskQuestion(question)}
                >
                  <MessageSquareText className="mr-2 h-4 w-4 shrink-0" />
                  {question}
                </Button>
              ))}

              <div className="rounded-2xl border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
                {isReadyForQuestions
                  ? 'Choose a question to send it directly into chat.'
                  : 'Suggested questions unlock after document processing completes.'}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
