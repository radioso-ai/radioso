'use client'

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { Spinner } from '@/components/ui/spinner'
import { settingsApi, RetrievalSettings } from '@/lib/api'
import { Save } from 'lucide-react'

export function SettingsView() {
  const [settings, setSettings] = useState<RetrievalSettings | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [hasChanges, setHasChanges] = useState(false)

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const data = await settingsApi.getRetrievalSettings()
        setSettings(data)
      } catch (error) {
        console.error('Failed to load settings:', error)
      } finally {
        setIsLoading(false)
      }
    }
    loadSettings()
  }, [])

  const updateSetting = <K extends keyof RetrievalSettings>(
    key: K,
    value: RetrievalSettings[K]
  ) => {
    if (!settings) return
    setSettings({ ...settings, [key]: value })
    setHasChanges(true)
  }

  const handleSave = async () => {
    if (!settings) return
    setIsSaving(true)
    try {
      await settingsApi.updateRetrievalSettings(settings)
      setHasChanges(false)
    } catch (error) {
      console.error('Failed to save settings:', error)
    } finally {
      setIsSaving(false)
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner className="w-6 h-6" />
      </div>
    )
  }

  if (!settings) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-muted-foreground">Failed to load settings</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-medium text-foreground">Settings</h1>
          <p className="text-sm text-muted-foreground">Configure retrieval parameters</p>
        </div>
        <Button size="sm" onClick={handleSave} disabled={!hasChanges || isSaving}>
          {isSaving ? <Spinner className="mr-2" /> : <Save className="w-4 h-4 mr-2" />}
          Save Changes
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-xl space-y-8">
          <div className="space-y-6">
            <h2 className="text-sm font-medium text-foreground uppercase tracking-wide">
              Retrieval Options
            </h2>

            <div className="flex items-center justify-between">
              <div>
                <Label htmlFor="queryRewrite" className="text-foreground">Query Rewrite</Label>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Automatically optimize queries for better retrieval
                </p>
              </div>
              <Switch
                id="queryRewrite"
                checked={settings.queryRewriteEnabled}
                onCheckedChange={(checked) => updateSetting('queryRewriteEnabled', checked)}
              />
            </div>

            <div className="flex items-center justify-between">
              <div>
                <Label htmlFor="rerank" className="text-foreground">Reranking</Label>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Use a reranker to improve result relevance
                </p>
              </div>
              <Switch
                id="rerank"
                checked={settings.rerankEnabled}
                onCheckedChange={(checked) => updateSetting('rerankEnabled', checked)}
              />
            </div>
          </div>

          <div className="space-y-6">
            <h2 className="text-sm font-medium text-foreground uppercase tracking-wide">
              Vector Search
            </h2>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label htmlFor="vectorTopK" className="text-foreground">Vector Top K</Label>
                <span className="text-sm text-muted-foreground font-mono">
                  {settings.vectorTopK}
                </span>
              </div>
              <Slider
                id="vectorTopK"
                min={1}
                max={300}
                step={1}
                value={[settings.vectorTopK]}
                onValueChange={([value]) => updateSetting('vectorTopK', value)}
              />
              <p className="text-sm text-muted-foreground">
                Number of chunks to retrieve from vector search
              </p>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label htmlFor="similarity" className="text-foreground">Similarity Threshold</Label>
                <span className="text-sm text-muted-foreground font-mono">
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
              <p className="text-sm text-muted-foreground">
                Minimum similarity score for retrieved chunks
              </p>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label htmlFor="rerankTopK" className="text-foreground">Rerank Top K</Label>
                <span className="text-sm text-muted-foreground font-mono">
                  {settings.rerankTopK}
                </span>
              </div>
              <Slider
                id="rerankTopK"
                min={1}
                max={50}
                step={1}
                value={[settings.rerankTopK]}
                onValueChange={([value]) => updateSetting('rerankTopK', value)}
              />
              <p className="text-sm text-muted-foreground">
                Number of chunks to keep after reranking
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
