'use client'

import { type ReactNode, useEffect, useState } from 'react'
import { Check, Code2, Copy, FileText, LoaderCircle, MessageSquareText } from 'lucide-react'
import { useRouter } from 'next/navigation'

import { Button } from '@/components/ui/button'
import { CopyValueField } from '@/components/ui/copy-value-field'
import { Spinner } from '@/components/ui/spinner'
import { buildDashboardHref } from '@/lib/dashboard-routes'
import { getApiErrorMessage } from '@/lib/api-error'
import { accountApi } from '@/lib/api'
import { type WorkspaceOnboardingState } from '@/lib/onboarding'
import { useWorkspace } from '@/lib/workspace-context'
import { cn } from '@/lib/utils'

interface FirstRunExperienceProps {
  accountId: string
  onboarding: WorkspaceOnboardingState
}

function StepRow({
  number,
  title,
  description,
  tone = 'upcoming',
  action,
}: {
  number: number
  title: string
  description: string
  tone?: 'active' | 'done' | 'upcoming'
  action?: ReactNode
}) {
  const badgeClassName =
    tone === 'done'
      ? 'border-primary/30 bg-primary/10 text-primary'
      : tone === 'active'
        ? 'border-foreground/20 bg-foreground text-background'
        : 'border-border bg-muted/40 text-muted-foreground'

  return (
    <li className="grid grid-cols-[32px_1fr] gap-4 border-b border-border/70 py-5 last:border-b-0">
      <div
        className={cn(
          'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-sm font-medium',
          badgeClassName,
        )}
      >
        {tone === 'done' ? <Check className="h-3.5 w-3.5" /> : number}
      </div>
      <div className="min-w-0 space-y-1">
        <p className="text-[15px] font-medium text-foreground">{title}</p>
        <p className={cn('text-[13px] leading-6 text-muted-foreground', tone === 'upcoming' && 'text-muted-foreground/80')}>
          {description}
        </p>
        {action ? (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {action}
          </div>
        ) : null}
      </div>
    </li>
  )
}

function ProgressHeader({
  completedCount,
}: {
  completedCount: number
}) {
  const progressWidth = `${Math.max(0, Math.min(100, (completedCount / 3) * 100))}%`

  return (
    <div className="flex items-center gap-3">
      <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-foreground transition-all" style={{ width: progressWidth }} />
      </div>
      <span className="whitespace-nowrap text-xs text-muted-foreground">
        {completedCount} of 3 complete
      </span>
    </div>
  )
}

function CodeSnippet({
  label,
  code,
}: {
  label: string
  code: string
}) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <section className="space-y-2">
      <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
      <div className="relative">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="absolute right-2 top-2 z-10 h-7 w-7 bg-background/90"
          onClick={() => void handleCopy()}
        >
          {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
          <span className="sr-only">Copy {label.toLowerCase()} instruction</span>
        </Button>
        <code className="block max-h-[420px] overflow-auto whitespace-pre rounded-md border border-border bg-muted/40 p-4 pr-12 font-mono text-sm leading-6 text-foreground">
          {code}
        </code>
      </div>
    </section>
  )
}

type ExampleLanguage = 'curl' | 'typescript'

function ExampleSelector({
  value,
  onChange,
}: {
  value: ExampleLanguage
  onChange: (value: ExampleLanguage) => void
}) {
  return (
    <div className="inline-flex rounded-md border border-border bg-muted/40 p-0.5">
      {(['curl', 'typescript'] as const).map((language) => (
        <Button
          key={language}
          type="button"
          size="sm"
          variant={value === language ? 'secondary' : 'ghost'}
          className="h-7 px-2.5 text-xs"
          aria-pressed={value === language}
          onClick={() => onChange(language)}
        >
          {language === 'curl' ? 'curl' : 'TypeScript'}
        </Button>
      ))}
    </div>
  )
}

const apiTokenLiteral = (apiToken: string | null) => (apiToken ? JSON.stringify(apiToken) : "'radioso_...'")
const curlApiToken = (apiToken: string | null) => apiToken ?? '$RADIOSO_API_TOKEN'

const buildCreateFromTextSnippet = (apiToken: string | null) => `import { createRadiosoClient } from '@radioso/typescript-sdk'

const client = createRadiosoClient({
  baseUrl: 'http://localhost:8080',
  apiToken: ${apiTokenLiteral(apiToken)},
})

await client.documents.create({
  title: 'Support FAQ',
  content: 'Radioso can answer questions grounded in uploaded content.',
})`

const buildCreateFromTextCurlSnippet = (apiToken: string | null) => `curl -sS -X POST http://localhost:8080/api/v1/document/ \\
  -H "Authorization: Bearer ${curlApiToken(apiToken)}" \\
  -H "Content-Type: application/json" \\
  -d '{"title":"Support FAQ","content":"Radioso can answer questions grounded in uploaded content."}'`

const askQuestionSnippet = `const response = await client.chat.create({
  message: 'What does the handbook say about refunds?',
  stream: false,
})

console.log(response.answer)`

const buildAskQuestionCurlSnippet = (apiToken: string | null) => `curl -sS -X POST http://localhost:8080/api/v1/assistant/chat \\
  -H "Authorization: Bearer ${curlApiToken(apiToken)}" \\
  -H "Content-Type: application/json" \\
  -d '{"message":"What does the handbook say about refunds?","stream":false}'`

function useInlineWorkspaceToken(workspaceId: string | null | undefined) {
  const [apiTokenState, setApiTokenState] = useState<{ workspaceId: string; token: string } | null>(null)
  const [apiTokenErrorState, setApiTokenErrorState] = useState<{ workspaceId: string; error: string } | null>(null)

  useEffect(() => {
    let isCurrent = true

    if (!workspaceId) {
      return undefined
    }

    void accountApi.getWorkspaceToken(workspaceId)
      .then((response) => {
        if (isCurrent) {
          setApiTokenState({ workspaceId, token: response.token })
        }
      })
      .catch((error) => {
        if (isCurrent) {
          setApiTokenErrorState({ workspaceId, error: getApiErrorMessage(error, 'Unable to load API token.') })
        }
      })

    return () => {
      isCurrent = false
    }
  }, [workspaceId])

  const apiToken = workspaceId && apiTokenState?.workspaceId === workspaceId ? apiTokenState.token : null
  const apiTokenError = workspaceId && apiTokenErrorState?.workspaceId === workspaceId ? apiTokenErrorState.error : null
  const isApiTokenLoading = Boolean(workspaceId) && !apiToken && !apiTokenError

  return {
    apiToken,
    apiTokenError: workspaceId ? apiTokenError : 'Select a workspace before viewing its API token.',
    isApiTokenLoading,
  }
}

function DeveloperUploadInstructions({
  apiToken,
  apiTokenError,
  exampleLanguage,
  isApiTokenLoading,
  isOpen,
  onExampleLanguageChange,
  onToggle,
}: {
  apiToken: string | null
  apiTokenError: string | null
  exampleLanguage: ExampleLanguage
  isApiTokenLoading: boolean
  isOpen: boolean
  onExampleLanguageChange: (value: ExampleLanguage) => void
  onToggle: () => void
}) {
  const code = exampleLanguage === 'curl'
    ? buildCreateFromTextCurlSnippet(apiToken)
    : buildCreateFromTextSnippet(apiToken)
  const label = exampleLanguage === 'curl' ? 'Create from text with curl' : 'Create from text with TypeScript'

  return (
    <>
      <Button size="sm" variant={isOpen ? 'secondary' : 'ghost'} aria-expanded={isOpen} onClick={onToggle}>
        <Code2 className="mr-2 h-4 w-4" />
        Upload with API or SDK
      </Button>
      {isOpen ? (
        <div className="mt-3 w-full basis-full space-y-4 rounded-md border border-border bg-background p-4">
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">Upload documents with the API or SDK</p>
            <p className="text-xs leading-5 text-muted-foreground">
              Use this instruction from trusted server-side code, scripts, or local tools.
            </p>
          </div>
          {isApiTokenLoading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner />
              Loading workspace API token...
            </div>
          ) : null}
          {apiTokenError ? <p className="text-sm text-destructive">{apiTokenError}</p> : null}
          {apiToken ? (
            <section className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">API token</p>
              <CopyValueField value={apiToken} ariaLabel="Copy API token" className="w-full" />
            </section>
          ) : null}
          <div className="space-y-2">
            <ExampleSelector value={exampleLanguage} onChange={onExampleLanguageChange} />
            <CodeSnippet label={label} code={code} />
          </div>
        </div>
      ) : null}
    </>
  )
}

function DeveloperChatInstructions({
  apiToken,
  apiTokenError,
  exampleLanguage,
  isApiTokenLoading,
  isOpen,
  onExampleLanguageChange,
  onToggle,
}: {
  apiToken: string | null
  apiTokenError: string | null
  exampleLanguage: ExampleLanguage
  isApiTokenLoading: boolean
  isOpen: boolean
  onExampleLanguageChange: (value: ExampleLanguage) => void
  onToggle: () => void
}) {
  const code = exampleLanguage === 'curl' ? buildAskQuestionCurlSnippet(apiToken) : askQuestionSnippet
  const label = exampleLanguage === 'curl' ? 'Ask a question with curl' : 'Ask a question with TypeScript'

  return (
    <>
      <Button size="sm" variant={isOpen ? 'secondary' : 'ghost'} aria-expanded={isOpen} onClick={onToggle}>
        <Code2 className="mr-2 h-4 w-4" />
        Chat with API or SDK
      </Button>
      {isOpen ? (
        <div className="mt-3 w-full basis-full space-y-4 rounded-md border border-border bg-background p-4">
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">Ask questions with the API or SDK</p>
            <p className="text-xs leading-5 text-muted-foreground">
              Ask the assistant from trusted server-side code, scripts, or local tools.
            </p>
          </div>
          {isApiTokenLoading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner />
              Loading workspace API token...
            </div>
          ) : null}
          {apiTokenError ? <p className="text-sm text-destructive">{apiTokenError}</p> : null}
          {apiToken ? (
            <section className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">API token</p>
              <CopyValueField value={apiToken} ariaLabel="Copy chat API token" className="w-full" />
            </section>
          ) : null}
          <div className="space-y-2">
            <ExampleSelector value={exampleLanguage} onChange={onExampleLanguageChange} />
            <CodeSnippet label={label} code={code} />
          </div>
        </div>
      ) : null}
    </>
  )
}

export function FirstRunExperience({ accountId, onboarding }: FirstRunExperienceProps) {
  const router = useRouter()
  const { activeWorkspace, activeWorkspaceId } = useWorkspace()
  const [areDeveloperInstructionsOpen, setAreDeveloperInstructionsOpen] = useState(false)
  const [developerExampleLanguage, setDeveloperExampleLanguage] = useState<ExampleLanguage>('curl')
  const { apiToken, apiTokenError, isApiTokenLoading } = useInlineWorkspaceToken(activeWorkspaceId)
  const isProcessing = onboarding.isImportingSampleDocs || onboarding.hasPendingDocuments
  const isReady = onboarding.hasReadyDocuments && !onboarding.hasPendingDocuments
  const hasDocuments = onboarding.hasDocuments
  const hasSampleDocuments = onboarding.sampleDocumentsImported
  const completedCount = Number(hasDocuments) + Number(isReady)

  const documentsHref = buildDashboardHref(accountId, {
    section: 'knowledge',
    workspaceId: activeWorkspaceId ?? undefined,
    workspacePublicRouteKey: activeWorkspace?.publicRouteKey,
  })

  const addDocumentsDescription = hasDocuments
    ? hasSampleDocuments
      ? 'Your workspace has Radioso docs. Open the list to review them or upload your own.'
      : 'Your workspace has documents. Open the list to review them or upload more.'
    : 'Upload your own files, or try a small set of Radioso docs first.'

  const processingDescription = isReady
    ? 'At least one document is processed and chat is ready.'
    : isProcessing
      ? 'Your documents are being indexed. Chat unlocks as soon as one is ready.'
      : 'Processing starts after you add your first document.'

  const chatDescription = isReady
    ? 'Open chat and ask the first question.'
    : 'Available once a document finishes processing.'

  const toggleDeveloperInstructions = () => {
    setAreDeveloperInstructionsOpen((value) => !value)
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[1040px] flex-1 items-center px-6 py-8">
        <div className="w-full py-8">
          <div className="mb-5 space-y-1.5">
            <h1 className="text-[20px] font-medium text-foreground">Get started with Radioso</h1>
            <p className="text-sm leading-6 text-muted-foreground">
              Upload documents and Radioso will let you ask questions grounded in your content.
            </p>
          </div>

          <div className="mb-7">
            <ProgressHeader completedCount={completedCount} />
          </div>

          <ol className="rounded-xl border border-border/70 bg-background px-5">
            <StepRow
              number={1}
              title="Add documents"
              description={addDocumentsDescription}
              tone={hasDocuments ? 'done' : 'active'}
              action={
                <>
                  <Button size="sm" variant="outline" onClick={() => router.push(documentsHref)}>
                    <FileText className="mr-2 h-4 w-4" />
                    {hasDocuments ? 'Open documents' : 'Upload documents'}
                  </Button>
                  {!hasDocuments ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={onboarding.isImportingSampleDocs}
                      onClick={() => {
                        void onboarding.importSampleDocs()
                      }}
                    >
                      <FileText className="mr-2 h-4 w-4" />
                      {onboarding.isImportingSampleDocs ? 'Adding Radioso docs...' : 'Try Radioso docs'}
                    </Button>
                  ) : null}
                  <DeveloperUploadInstructions
                    apiToken={apiToken}
                    apiTokenError={apiTokenError}
                    exampleLanguage={developerExampleLanguage}
                    isApiTokenLoading={isApiTokenLoading}
                    isOpen={areDeveloperInstructionsOpen}
                    onExampleLanguageChange={setDeveloperExampleLanguage}
                    onToggle={toggleDeveloperInstructions}
                  />
                </>
              }
            />

            <StepRow
              number={2}
              title={isReady ? 'Documents processed' : 'Processing'}
              description={processingDescription}
              tone={isReady ? 'done' : hasDocuments ? 'active' : 'upcoming'}
              action={
                isProcessing ? (
                  <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                    Processing...
                  </span>
                ) : null
              }
            />

            <StepRow
              number={3}
              title="Ask a question"
              description={chatDescription}
              tone={isReady ? 'active' : 'upcoming'}
              action={
                <>
                  {isReady ? (
                    <Button
                      size="sm"
                      onClick={() => {
                        onboarding.markCompleted()
                        router.push(buildDashboardHref(accountId, {
                          section: 'agents',
                          workspaceId: activeWorkspaceId ?? undefined,
                          workspacePublicRouteKey: activeWorkspace?.publicRouteKey,
                        }))
                      }}
                    >
                      <MessageSquareText className="mr-2 h-4 w-4" />
                      Open chat
                    </Button>
                  ) : null}
                  <DeveloperChatInstructions
                    apiToken={apiToken}
                    apiTokenError={apiTokenError}
                    exampleLanguage={developerExampleLanguage}
                    isApiTokenLoading={isApiTokenLoading}
                    isOpen={areDeveloperInstructionsOpen}
                    onExampleLanguageChange={setDeveloperExampleLanguage}
                    onToggle={toggleDeveloperInstructions}
                  />
                </>
              }
            />
          </ol>

          <div className="mt-4 flex justify-end">
            <Button size="sm" variant="ghost" onClick={onboarding.markCompleted}>
              Skip
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
