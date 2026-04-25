'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'

import { chatApi, documentsApi, type DocumentSummary } from '@/lib/api'

const ONBOARDING_ACTIVE_KEY = 'radioso.onboardingActive'
const ONBOARDING_COMPLETED_KEY = 'radioso.onboardingCompleted'

type OnboardingStorageMap = Record<string, boolean>

const readBooleanMap = (key: string): OnboardingStorageMap => {
  if (typeof window === 'undefined') {
    return {}
  }

  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) {
      return {}
    }

    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }

    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'),
    )
  } catch {
    return {}
  }
}

const writeBooleanMap = (key: string, value: OnboardingStorageMap) => {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(key, JSON.stringify(value))
}

const setWorkspaceFlag = (key: string, workspaceId: string, enabled: boolean) => {
  const next = readBooleanMap(key)
  if (enabled) {
    next[workspaceId] = true
  } else {
    delete next[workspaceId]
  }
  writeBooleanMap(key, next)
}

const getWorkspaceFlag = (key: string, workspaceId: string) => readBooleanMap(key)[workspaceId] === true
export const markOnboardingActive = (workspaceId: string) => {
  setWorkspaceFlag(ONBOARDING_ACTIVE_KEY, workspaceId, true)
}

export const markOnboardingCompleted = (workspaceId: string) => {
  setWorkspaceFlag(ONBOARDING_COMPLETED_KEY, workspaceId, true)
  setWorkspaceFlag(ONBOARDING_ACTIVE_KEY, workspaceId, false)
}

export const SAMPLE_DOCUMENTS = [
  {
    title: 'Getting Started with Radioso',
    slug: 'getting-started',
    content: `# Getting Started with Radioso

Radioso is easiest to start with \`./run-dev.sh\`. The bootstrap checks Docker, prepares \`backend/.env\`, and starts the local stack.

After the app opens, sign in or create an account. Radioso creates your first workspace automatically, so you can focus on loading content instead of configuring tenants.

To add content, open Documents and either import a file or add inline markdown. Once processing finishes, open Chat and ask a question about the material you loaded.

For the fastest first run, use the built-in sample docs, wait for them to finish processing, and ask one of the suggested questions.`,
  },
  {
    title: 'Radioso Architecture',
    slug: 'architecture',
    content: `# Radioso Architecture

Radioso uses a retrieval-augmented generation pipeline. Documents are normalized, chunked, embedded, and indexed for later retrieval.

At query time, the system can rewrite the question, run semantic and lexical retrieval, merge candidates, apply structured constraints, rerank results, and assemble grounded context for the final answer.

Chunking can follow fixed-window or structured-semantic strategies. Retrieval diagnostics, citations, and trace data help explain how an answer was formed.`,
  },
  {
    title: 'Configuration Reference',
    slug: 'configuration-reference',
    content: `# Configuration Reference

Local setup centers on a small set of environment values: \`DATABASE_URL\`, session secrets, upload limits, and provider credentials.

\`LLM_PROVIDER\` selects the default model provider. OpenAI is the default path, while OpenAI-compatible, Gemini, and Claude providers are also supported when the corresponding keys are configured.

Workspace settings control retrieval behavior such as rewrite, rerank, chunking, citation display, and anonymous chat access. API tokens are workspace-scoped and intended for SDK or curl usage after the workspace is already working in the UI.`,
  },
] as const

export const SAMPLE_QUESTIONS = [
  'How do I get started with Radioso locally?',
  'Explain the Radioso retrieval pipeline in plain language.',
  'Which environment variables matter most for local setup?',
] as const

export interface WorkspaceOnboardingState {
  isLoading: boolean
  refresh: () => Promise<void>
  documents: DocumentSummary[]
  hasDocuments: boolean
  hasPendingDocuments: boolean
  hasReadyDocuments: boolean
  hasCompletedChat: boolean
  sampleDocumentsImported: boolean
  isOnboardingActive: boolean
  isOnboardingCompleted: boolean
  shouldShowFirstRun: boolean
  importSampleDocs: () => Promise<void>
  isImportingSampleDocs: boolean
  markCompleted: () => void
  markActive: () => void
}

const isPendingDocument = (document: DocumentSummary) => {
  const normalizedStatus = document.status.toLowerCase()
  return normalizedStatus === 'queued' || normalizedStatus === 'processing' || document.ragStatus === 'pending'
}

const isSampleDocument = (document: DocumentSummary) => document.metadata.sampleDocument === true

export const shouldAutoActivateOnboarding = (input: {
  workspaceId: string
  workspaceCount: number
  documentCount: number
  conversationCount: number
}): boolean => {
  if (input.documentCount > 0 || input.conversationCount > 0) {
    return false
  }

  if (getWorkspaceFlag(ONBOARDING_COMPLETED_KEY, input.workspaceId)) {
    return false
  }

  return true
}

export const useWorkspaceOnboarding = (
  workspaceId: string | null,
  workspaceCount: number,
): WorkspaceOnboardingState => {
  const [isLoading, setIsLoading] = useState(true)
  const [documents, setDocuments] = useState<DocumentSummary[]>([])
  const [hasCompletedChat, setHasCompletedChat] = useState(false)
  const [isOnboardingActive, setIsOnboardingActive] = useState(false)
  const [isOnboardingCompleted, setIsOnboardingCompleted] = useState(false)
  const [isImportingSampleDocs, setIsImportingSampleDocs] = useState(false)

  const refresh = useCallback(async () => {
    if (!workspaceId) {
      setDocuments([])
      setHasCompletedChat(false)
      setIsOnboardingActive(false)
      setIsOnboardingCompleted(false)
      setIsLoading(false)
      return
    }

    setIsLoading(true)

    try {
      const [documentPage, conversationPage] = await Promise.all([
        documentsApi.listDocuments({ limit: 100, offset: 0 }),
        chatApi.listHistory({ limit: 100, offset: 0 }),
      ])
      const nextDocuments = documentPage.documents
      const conversations = conversationPage.conversations

      const nextCompleted = conversationPage.total > 0 || getWorkspaceFlag(ONBOARDING_COMPLETED_KEY, workspaceId)
      const nextActive =
        !nextCompleted &&
        (getWorkspaceFlag(ONBOARDING_ACTIVE_KEY, workspaceId) ||
          shouldAutoActivateOnboarding({
            workspaceId,
            workspaceCount,
            documentCount: documentPage.total,
            conversationCount: conversationPage.total,
          }))

      if (nextActive) {
        markOnboardingActive(workspaceId)
      }

      setDocuments(nextDocuments)
      setHasCompletedChat(conversationPage.total > 0)
      setIsOnboardingCompleted(nextCompleted)
      setIsOnboardingActive(nextActive)
    } finally {
      setIsLoading(false)
    }
  }, [workspaceCount, workspaceId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!workspaceId) {
      return
    }

    if (!isOnboardingActive) {
      return
    }

    if (!documents.some(isPendingDocument)) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      void refresh()
    }, 2000)

    return () => window.clearTimeout(timeoutId)
  }, [documents, isOnboardingActive, refresh, workspaceId])

  const importSampleDocs = useCallback(async () => {
    if (!workspaceId) {
      return
    }

    setIsImportingSampleDocs(true)
    markOnboardingActive(workspaceId)
    setIsOnboardingActive(true)

    try {
      const existingSlugs = new Set(
        documents
          .filter(isSampleDocument)
          .map((document) => document.metadata.sampleSlug)
          .filter((value): value is string => typeof value === 'string'),
      )

      const missingDocs = SAMPLE_DOCUMENTS.filter((document) => !existingSlugs.has(document.slug))

      await Promise.all(
        missingDocs.map((document) =>
          documentsApi.createDocument({
            title: document.title,
            content: document.content,
            metadata: {
              sampleDocument: true,
              sampleSlug: document.slug,
              source: 'guided_onboarding',
            },
          }),
        ),
      )

      await refresh()
    } finally {
      setIsImportingSampleDocs(false)
    }
  }, [documents, refresh, workspaceId])

  const markCompleted = useCallback(() => {
    if (!workspaceId) {
      return
    }

    markOnboardingCompleted(workspaceId)
    setIsOnboardingCompleted(true)
    setIsOnboardingActive(false)
  }, [workspaceId])

  const markActive = useCallback(() => {
    if (!workspaceId) {
      return
    }

    markOnboardingActive(workspaceId)
    setIsOnboardingActive(true)
  }, [workspaceId])

  const value = useMemo<WorkspaceOnboardingState>(() => {
    const hasDocuments = documents.length > 0
    const hasPendingDocuments = documents.some(isPendingDocument)
    const hasReadyDocuments = documents.some((document) => document.ragStatus === 'processed')
    const sampleDocumentsImported = documents.some(isSampleDocument)

    return {
      isLoading,
      refresh,
      documents,
      hasDocuments,
      hasPendingDocuments,
      hasReadyDocuments,
      hasCompletedChat,
      sampleDocumentsImported,
      isOnboardingActive,
      isOnboardingCompleted,
      shouldShowFirstRun: isOnboardingActive && !isOnboardingCompleted && !hasCompletedChat,
      importSampleDocs,
      isImportingSampleDocs,
      markCompleted,
      markActive,
    }
  }, [
    documents,
    hasCompletedChat,
    importSampleDocs,
    isImportingSampleDocs,
    isLoading,
    isOnboardingActive,
    isOnboardingCompleted,
    markActive,
    markCompleted,
    refresh,
  ])

  return value
}
