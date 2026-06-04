'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Search, SlidersHorizontal } from 'lucide-react'

import { AssistantMarkdownContent } from '@/components/dashboard/chat-markdown'
import { MetadataRulesEditor } from '@/components/dashboard/settings/metadata-rules-editor'
import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { retrievalSettingDocs } from '@/components/dashboard/settings/settings-docs'
import { SettingFieldHeader, SettingTooltip } from '@/components/dashboard/settings/settings-flow'
import { SettingsTabShell } from '@/components/dashboard/settings/settings-tab-shell'
import { useSettingsSaveStatus } from '@/components/dashboard/settings/use-settings-save-status'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { LogoSpinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { type RetrievalSettings, settingsApi } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'

export function RetrievalSettingsPanel({
  onSaveStateChange,
}: {
  onSaveStateChange?: (input: { state: 'idle' | 'saved' | 'saving' | 'error'; message?: string | null }) => void
}) {
  const { activeWorkspaceId, isLoading: isWorkspaceLoading } = useWorkspace()
  const [settings, setSettings] = useState<RetrievalSettings | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [lastSavedSettings, setLastSavedSettings] = useState<RetrievalSettings | null>(null)
  const { beginSave, isCurrentSave, markError, markSaved, resetSaveState } = useSettingsSaveStatus(onSaveStateChange)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const hasLoadedRef = useRef(false)
  const draftVersionRef = useRef(0)

  useEffect(() => {
    if (isWorkspaceLoading || !activeWorkspaceId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Workspace changes reset this async settings panel to loading.
      setIsLoading(true)
      return
    }

    let active = true
    const loadSettings = async () => {
      try {
        const data = await settingsApi.getRetrievalSettings()
        if (!active) return
        setSettings(data)
        setLastSavedSettings(data)
        resetSaveState()
      } catch (error) {
        if (!active) return
        console.error('Failed to load settings:', error)
      } finally {
        if (active) {
          setIsLoading(false)
          hasLoadedRef.current = true
        }
      }
    }
    void loadSettings()
    return () => {
      active = false
    }
  }, [activeWorkspaceId, isWorkspaceLoading, resetSaveState])

  const updateSettingsDraft = (updater: (current: RetrievalSettings) => RetrievalSettings) => {
    draftVersionRef.current += 1
    setSettings((current) => (current ? updater(current) : current))
  }

  const updateSetting = <K extends keyof RetrievalSettings>(key: K, value: RetrievalSettings[K]) => {
    updateSettingsDraft((current) => ({ ...current, [key]: value }))
  }

  const settingsSignature = useMemo(() => JSON.stringify(settings), [settings])
  const lastSavedSignature = useMemo(() => JSON.stringify(lastSavedSettings), [lastSavedSettings])

  useEffect(() => {
    if (!hasLoadedRef.current || !settings || !lastSavedSettings) {
      return
    }

    if (settingsSignature === lastSavedSignature) {
      return
    }

    const saveId = beginSave()

    const timeout = window.setTimeout(async () => {
      const draftVersionAtRequestStart = draftVersionRef.current
      try {
        const saved = await settingsApi.updateRetrievalSettings(settings)
        if (!isCurrentSave(saveId)) {
          return
        }
        setLastSavedSettings(saved)
        if (draftVersionRef.current === draftVersionAtRequestStart) {
          setSettings(saved)
          markSaved()
        }
      } catch (error) {
        if (!isCurrentSave(saveId)) {
          return
        }
        console.error('Failed to save settings:', error)
        markError('Failed to save changes. Your latest edits are still in the browser.')
      }
    }, 700)

    return () => window.clearTimeout(timeout)
  }, [beginSave, isCurrentSave, lastSavedSettings, lastSavedSignature, markError, markSaved, settings, settingsSignature])

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <LogoSpinner imageClassName="h-7 w-7" />
      </div>
    )
  }

  if (!settings) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground">Failed to load settings</p>
      </div>
    )
  }

  return (
    <SettingsTabShell>
      <div className="space-y-6">
        <SettingsCard
          id="query-rewrite"
          icon={<Search className="h-5 w-5 text-primary" />}
          eyebrow="Find The Right Evidence"
          title="Query rewrite"
          description="Let the system rewrite the user’s question into optimized semantic and lexical search queries."
        >
          <div className="flex items-center justify-between rounded-md border border-border bg-muted/20 p-3">
            <div>
              <div className="flex items-center gap-1.5">
                <Label htmlFor="queryRewrite" className="text-foreground">
                  {retrievalSettingDocs.queryRewriteEnabled.label}
                </Label>
                <SettingTooltip
                  label={retrievalSettingDocs.queryRewriteEnabled.label}
                  content={retrievalSettingDocs.queryRewriteEnabled.details}
                />
              </div>
              <div className="mt-0.5 text-sm text-muted-foreground">
                <AssistantMarkdownContent content={retrievalSettingDocs.queryRewriteEnabled.summary} inline />
              </div>
            </div>
            <Switch
              id="queryRewrite"
              checked={settings.queryRewriteEnabled}
              onCheckedChange={(checked) => updateSetting('queryRewriteEnabled', checked)}
            />
          </div>
        </SettingsCard>

        <SettingsCard
          id="retrieval-strategy"
          icon={<SlidersHorizontal className="h-5 w-5 text-primary" />}
          eyebrow="How Answers Are Produced"
          title="Answering strategy"
          description="Choose how this workspace produces grounded answers."
        >
          <div className="flex items-center justify-between rounded-md border border-border bg-muted/20 p-3">
            <div>
              <div className="flex items-center gap-1.5">
                <Label htmlFor="retrievalStrategy" className="text-foreground">
                  {retrievalSettingDocs.retrievalStrategy.label}
                </Label>
                <SettingTooltip
                  label={retrievalSettingDocs.retrievalStrategy.label}
                  content={retrievalSettingDocs.retrievalStrategy.details}
                />
              </div>
              <div className="mt-0.5 text-sm text-muted-foreground">
                <AssistantMarkdownContent content={retrievalSettingDocs.retrievalStrategy.summary} inline />
              </div>
            </div>
            <Select
              value={settings.retrievalStrategy}
              onValueChange={(value) =>
                updateSetting('retrievalStrategy', value as RetrievalSettings['retrievalStrategy'])
              }
            >
              <SelectTrigger id="retrievalStrategy" className="w-full sm:w-[240px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fixed">Standard</SelectItem>
                <SelectItem value="reasoning">Reasoning (experimental)</SelectItem>
                <SelectItem value="auto">Automatic</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </SettingsCard>

        <SettingsCard
          id="metadata-rules"
          eyebrow="Find The Right Evidence"
          icon={<SlidersHorizontal className="h-5 w-5 text-primary" />}
          title="Filtering and boosting by document metadata"
          description="Use document metadata to consistently prefer or require certain results during retrieval."
        >
          <MetadataRulesEditor
            metadataRules={settings.metadataRules}
            metadataFieldSuggestions={settings.metadataFieldSuggestions}
            onChange={(metadataRules) => updateSetting('metadataRules', metadataRules)}
          />
        </SettingsCard>

        <SettingsCard
          id="search-tuning"
          eyebrow="Advanced"
          icon={<Search className="h-5 w-5 text-primary" />}
          title="Advanced search tuning"
          description="Adjust candidate recall, thresholding, and reranking. These controls are most useful when you are actively tuning retrieval quality."
        >
          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex w-full items-center justify-between rounded-xl border border-border bg-muted/20 px-4 py-3 text-left"
              >
                <div>
                  <p className="text-sm font-medium text-foreground">Searching and reranking</p>
                  <p className="text-sm text-muted-foreground">
                    Advanced controls for recall, filtering sensitivity, and reranking behavior.
                  </p>
                </div>
                <ChevronDown
                  className={`h-4 w-4 text-muted-foreground transition-transform ${advancedOpen ? 'rotate-180' : ''}`}
                />
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-4">
              <div className="space-y-4">
                <div className="space-y-4 rounded-md border border-border bg-muted/20 p-4">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <SettingFieldHeader
                        htmlFor="vectorTopK"
                        label={retrievalSettingDocs.vectorTopK.label}
                        description={retrievalSettingDocs.vectorTopK.summary}
                        tooltip={retrievalSettingDocs.vectorTopK.details}
                        className="pr-4"
                      />
                      <span className="text-sm font-mono text-muted-foreground">{settings.vectorTopK}</span>
                    </div>
                    <Slider
                      id="vectorTopK"
                      min={1}
                      max={300}
                      step={1}
                      value={[settings.vectorTopK]}
                      onValueChange={([value]) => updateSetting('vectorTopK', value)}
                    />
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <SettingFieldHeader
                        htmlFor="similarity"
                        label={retrievalSettingDocs.similarityThreshold.label}
                        description={retrievalSettingDocs.similarityThreshold.summary}
                        tooltip={retrievalSettingDocs.similarityThreshold.details}
                        className="pr-4"
                      />
                      <span className="text-sm font-mono text-muted-foreground">
                        {settings.similarityThreshold.toFixed(2)}
                      </span>
                    </div>
                    <Slider
                      id="similarity"
                      min={0}
                      max={1}
                      step={0.01}
                      value={[settings.similarityThreshold]}
                      onValueChange={([value]) => updateSetting('similarityThreshold', value)}
                    />
                  </div>
                </div>

                <div className="space-y-4 rounded-md border border-border bg-muted/20 p-4">
                  <div className="flex items-center justify-between rounded-md border border-border bg-background/60 p-3">
                    <div>
                      <div className="flex items-center gap-1.5">
                        <Label htmlFor="rerank" className="text-foreground">
                          {retrievalSettingDocs.rerankEnabled.label}
                        </Label>
                        <SettingTooltip
                          label={retrievalSettingDocs.rerankEnabled.label}
                          content={retrievalSettingDocs.rerankEnabled.details}
                        />
                      </div>
                      <div className="mt-0.5 text-sm text-muted-foreground">
                        <AssistantMarkdownContent content={retrievalSettingDocs.rerankEnabled.summary} inline />
                      </div>
                    </div>
                    <Switch
                      id="rerank"
                      checked={settings.rerankEnabled}
                      onCheckedChange={(checked) => updateSetting('rerankEnabled', checked)}
                    />
                  </div>

                  {settings.rerankEnabled ? (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <SettingFieldHeader
                          htmlFor="rerankTopK"
                          label={retrievalSettingDocs.rerankTopK.label}
                          description={retrievalSettingDocs.rerankTopK.summary}
                          tooltip={retrievalSettingDocs.rerankTopK.details}
                          className="pr-4"
                        />
                        <span className="text-sm font-mono text-muted-foreground">{settings.rerankTopK}</span>
                      </div>
                      <Slider
                        id="rerankTopK"
                        min={1}
                        max={50}
                        step={1}
                        value={[settings.rerankTopK]}
                        onValueChange={([value]) => updateSetting('rerankTopK', value)}
                      />
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Enable reranking to tune how many candidates survive the rerank pass.
                    </p>
                  )}
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </SettingsCard>
      </div>
    </SettingsTabShell>
  )
}
