'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { documentsApi, workspaceApi, type DocumentSummary } from '@/lib/api'
import {
  isOnboardingActive as getOnboardingActiveFlag,
  isOnboardingCompleted as getOnboardingCompletedFlag,
  markOnboardingActive,
  markOnboardingCompleted,
} from '@/lib/onboarding-storage'

export { markOnboardingActive, markOnboardingCompleted } from '@/lib/onboarding-storage'

export const SAMPLE_DOCUMENTS = [
  {
    title: 'Getting Started with Radioso',
    slug: 'getting-started',
    content: `# Getting Started with Radioso

Radioso is easiest to start with \`./run-dev.sh\`. The bootstrap checks Docker, prepares \`.env\`, and starts the local stack.

After the app opens, sign in or create an account. Radioso creates your first workspace automatically, so you can focus on loading content instead of configuring tenants.

To add content, open Documents and either import a file or add inline markdown. Once processing finishes, open Chat and ask a question about the material you loaded.

Answering is the first thing an agent does, not the last. Once the first answer looks right, open the agent's settings to add a directive that steers how it behaves, a skill it can act with, or a routine that carries a request across several turns.

For the fastest first run, use the built-in sample docs, wait for them to finish processing, and ask one of the suggested questions.`,
  },
  {
    title: 'Radioso Architecture',
    slug: 'architecture',
    content: `# Radioso Architecture

Radioso turns workspace documents into context for conversational agents. Documents are normalized, chunked, embedded, and indexed for later retrieval.

At query time, the system can rewrite the question, run semantic and lexical retrieval, merge candidates, apply structured constraints, rerank results, and assemble grounded context for the final answer.

Chunking can follow fixed-window or structured-semantic strategies. Retrieval diagnostics, citations, and trace data help explain how an answer was formed.`,
  },
  {
    title: 'Configuration Reference',
    slug: 'configuration-reference',
    content: `# Configuration Reference

Local setup centers on a small set of environment values: \`DATABASE_URL\`, session secrets, upload limits, and provider credentials.

\`LLM_PROVIDER\` selects the default model provider. OpenAI is the default path, while OpenAI-compatible, Gemini, and Claude providers are also supported when the corresponding keys are configured.

Workspace settings control retrieval behavior such as rewrite, rerank, chunking, citation display, and anonymous chat access. Personal tokens and service-account credentials support SDK or curl usage after the workspace is already working in the UI.`,
  },
] as const

export const SAMPLE_QUESTIONS = [
  'How do I get started with Radioso locally?',
  'How does Radioso use my documents as context?',
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
  websiteCrawlerEnabled: boolean
  isOnboardingActive: boolean
  isOnboardingCompleted: boolean
  shouldShowFirstRun: boolean
  importSampleDocs: () => Promise<void>
  isImportingSampleDocs: boolean
  markCompleted: () => void
  markActive: () => void
}

export const shouldAutoActivateOnboarding = (input: {
  workspaceId: string
  workspaceCount: number
  documentCount: number
  conversationCount: number
}): boolean => {
  if (input.documentCount > 0 || input.conversationCount > 0) {
    return false
  }

  if (getOnboardingCompletedFlag(input.workspaceId)) {
    return false
  }

  return true
}

export const useWorkspaceOnboarding = (
  workspaceId: string | null,
  workspaceCount: number,
): WorkspaceOnboardingState => {
  const [isLoading, setIsLoading] = useState(true)
  const [sampleDocumentSlugs, setSampleDocumentSlugs] = useState<string[]>([])
  const [hasDocuments, setHasDocuments] = useState(false)
  const [hasPendingDocuments, setHasPendingDocuments] = useState(false)
  const [hasReadyDocuments, setHasReadyDocuments] = useState(false)
  const [sampleDocumentsImported, setSampleDocumentsImported] = useState(false)
  const [hasCompletedChat, setHasCompletedChat] = useState(false)
  const [websiteCrawlerEnabled, setWebsiteCrawlerEnabled] = useState(true)
  const [isOnboardingActive, setIsOnboardingActive] = useState(false)
  const [isOnboardingCompleted, setIsOnboardingCompleted] = useState(false)
  const [isImportingSampleDocs, setIsImportingSampleDocs] = useState(false)
  const loadedWorkspaceIdRef = useRef<string | null>(null)

  const refresh = useCallback(async () => {
    if (!workspaceId) {
      setSampleDocumentSlugs([])
      setHasDocuments(false)
      setHasPendingDocuments(false)
      setHasReadyDocuments(false)
      setSampleDocumentsImported(false)
      setHasCompletedChat(false)
      setIsOnboardingActive(false)
      setIsOnboardingCompleted(false)
      loadedWorkspaceIdRef.current = null
      setIsLoading(false)
      return
    }

    const isInitialWorkspaceLoad = loadedWorkspaceIdRef.current !== workspaceId
    if (isInitialWorkspaceLoad) {
      loadedWorkspaceIdRef.current = workspaceId
      setIsLoading(true)
    }

    try {
      const summary = await workspaceApi.getSummary()

      const nextCompleted = summary.hasCompletedChat || getOnboardingCompletedFlag(workspaceId)
      const nextActive =
        !nextCompleted &&
        (getOnboardingActiveFlag(workspaceId) ||
          shouldAutoActivateOnboarding({
            workspaceId,
            workspaceCount,
            documentCount: summary.documentCount,
            conversationCount: summary.conversationCount,
          }))

      if (nextActive) {
        markOnboardingActive(workspaceId)
      }

      setSampleDocumentSlugs(summary.sampleDocumentSlugs)
      setHasDocuments(summary.hasDocuments)
      setHasPendingDocuments(summary.hasPendingDocuments)
      setHasReadyDocuments(summary.hasReadyDocuments)
      setSampleDocumentsImported(summary.sampleDocumentsImported)
      setHasCompletedChat(summary.hasCompletedChat)
      setWebsiteCrawlerEnabled(summary.websiteCrawlerEnabled)
      setIsOnboardingCompleted(nextCompleted)
      setIsOnboardingActive(nextActive)
    } finally {
      setIsLoading(false)
    }
  }, [workspaceCount, workspaceId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Initial onboarding refresh synchronizes API state for the active workspace.
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!workspaceId) {
      return
    }

    if (!isOnboardingActive) {
      return
    }

    if (!hasPendingDocuments) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      void refresh()
    }, 2000)

    return () => window.clearTimeout(timeoutId)
  }, [hasPendingDocuments, isOnboardingActive, refresh, workspaceId])

  const importSampleDocs = useCallback(async () => {
    if (!workspaceId) {
      return
    }

    setIsImportingSampleDocs(true)
    markOnboardingActive(workspaceId)
    setIsOnboardingActive(true)

    try {
      const existingSlugs = new Set(sampleDocumentSlugs)

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
  }, [refresh, sampleDocumentSlugs, workspaceId])

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
    return {
      isLoading,
      refresh,
      documents: [],
      hasDocuments,
      hasPendingDocuments,
      hasReadyDocuments,
      hasCompletedChat,
      sampleDocumentsImported,
      websiteCrawlerEnabled,
      isOnboardingActive,
      isOnboardingCompleted,
      shouldShowFirstRun: isOnboardingActive && !isOnboardingCompleted && !hasCompletedChat,
      importSampleDocs,
      isImportingSampleDocs,
      markCompleted,
      markActive,
    }
  }, [
    hasCompletedChat,
    hasDocuments,
    hasPendingDocuments,
    hasReadyDocuments,
    importSampleDocs,
    isImportingSampleDocs,
    isLoading,
    isOnboardingActive,
    isOnboardingCompleted,
    markActive,
    markCompleted,
    refresh,
    sampleDocumentsImported,
    websiteCrawlerEnabled,
  ])

  return value
}
