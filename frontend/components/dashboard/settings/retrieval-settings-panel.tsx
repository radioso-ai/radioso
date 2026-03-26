'use client'

import { useEffect, useState } from 'react'
import { Bot, Save, Search, SlidersHorizontal } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { type RetrievalSettings, settingsApi } from '@/lib/api'
import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import {
  attributeFamilyOptions,
  attributeModeLabels,
} from '@/components/dashboard/settings/settings-options'

export function RetrievalSettingsPanel() {
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
    void loadSettings()
  }, [])

  const updateSetting = <K extends keyof RetrievalSettings>(key: K, value: RetrievalSettings[K]) => {
    if (!settings) return
    setSettings({ ...settings, [key]: value })
    setHasChanges(true)
  }

  const updateAttributeControl = (
    family: RetrievalSettings['attributeControls'][number]['family'],
    updates: Partial<RetrievalSettings['attributeControls'][number]>,
  ) => {
    if (!settings) return
    setSettings({
      ...settings,
      attributeControls: settings.attributeControls.map((control) =>
        control.family === family ? { ...control, ...updates } : control,
      ),
    })
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
          <h2 className="text-lg font-medium text-foreground">Retrieval Settings</h2>
          <p className="text-sm text-muted-foreground">Tune retrieval and response behavior</p>
        </div>
        <Button size="sm" onClick={handleSave} disabled={!hasChanges || isSaving}>
          {isSaving ? <Spinner className="mr-2" /> : <Save className="w-4 h-4 mr-2" />}
          Save Changes
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-xl space-y-8">
          <SettingsCard
            icon={<Bot className="h-5 w-5 text-primary" />}
            title="Assistant"
            description="Control how grounded answers are presented to the user."
          >
            <div className="space-y-4">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label htmlFor="warmthLevel" className="text-foreground">Warmth</Label>
                  <span className="text-sm text-muted-foreground font-mono">{settings.warmthLevel}</span>
                </div>
                <Slider
                  id="warmthLevel"
                  min={1}
                  max={10}
                  step={1}
                  value={[settings.warmthLevel]}
                  onValueChange={([value]) => updateSetting('warmthLevel', value)}
                />
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Terse</span>
                  <span>Very warm</span>
                </div>
                <p className="text-sm text-muted-foreground">
                  Controls how concise or warm the assistant sounds without changing the underlying answer.
                </p>
              </div>

              <div className="flex items-center justify-between rounded-md border border-border bg-muted/20 p-3">
                <div>
                  <Label htmlFor="citationDisplay" className="text-foreground">Show Citations</Label>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    Show inline source markers when supporting evidence is available.
                  </p>
                </div>
                <Switch
                  id="citationDisplay"
                  checked={settings.citationDisplayEnabled}
                  onCheckedChange={(checked) => updateSetting('citationDisplayEnabled', checked)}
                />
              </div>

              <div className="space-y-3">
                <div className="space-y-1">
                  <Label htmlFor="customInstruction" className="text-foreground">Custom Instruction</Label>
                  <p className="text-sm text-muted-foreground">
                    Give the assistant workspace-specific instructions. For example: &quot;Always cite the paragraph number when referencing legal provisions&quot; or &quot;Include a direct URL instead of saying visit their website.&quot;
                  </p>
                </div>
                <Textarea
                  id="customInstruction"
                  value={settings.customInstruction}
                  onChange={(event) => updateSetting('customInstruction', event.target.value.slice(0, 2000))}
                  placeholder="e.g. Always cite the specific section of the Act when referencing legal provisions."
                  rows={4}
                />
                <p className="text-xs text-muted-foreground text-right">
                  {settings.customInstruction.length} / 2000
                </p>
              </div>

              <p className="text-sm text-muted-foreground">
                The assistant may still ask a clarification question when your request is missing information needed for a reliable answer.
              </p>
            </div>
          </SettingsCard>

          <SettingsCard
            icon={<Search className="h-5 w-5 text-primary" />}
            title="Retrieval Pipeline"
            description="Control how the system expands, filters, and reranks evidence."
          >
            <div className="space-y-4">
              <div className="flex items-center justify-between rounded-md border border-border bg-muted/20 p-3">
                <div>
                  <Label htmlFor="queryRewrite" className="text-foreground">Query Rewrite</Label>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    Automatically optimize queries for better retrieval.
                  </p>
                </div>
                <Switch
                  id="queryRewrite"
                  checked={settings.queryRewriteEnabled}
                  onCheckedChange={(checked) => updateSetting('queryRewriteEnabled', checked)}
                />
              </div>

              <div className="flex items-center justify-between rounded-md border border-border bg-muted/20 p-3">
                <div>
                  <Label htmlFor="rerank" className="text-foreground">Reranking</Label>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    Use a reranker to improve result relevance.
                  </p>
                </div>
                <Switch
                  id="rerank"
                  checked={settings.rerankEnabled}
                  onCheckedChange={(checked) => updateSetting('rerankEnabled', checked)}
                />
              </div>

              <div className="space-y-4 rounded-md border border-border bg-muted/20 p-4">
                <div className="space-y-1">
                  <Label className="text-foreground">Structured Attributes</Label>
                  <p className="text-sm text-muted-foreground">
                    These are system-defined retrieval helpers, not custom fields. Enable the families
                    you want the retriever to consider, and choose whether each one should only boost
                    matches or may act as a high-confidence hard filter.
                  </p>
                </div>

                <div className="space-y-3">
                  {attributeFamilyOptions.map((option) => {
                    const control = settings.attributeControls.find(
                      (candidate) => candidate.family === option.family,
                    )

                    if (!control) {
                      return null
                    }

                    return (
                      <div key={option.family} className="space-y-3 rounded-md border border-border bg-card p-4">
                        <div className="flex items-start justify-between gap-4">
                          <div className="space-y-1">
                            <p className="text-sm font-medium text-foreground">{option.label}</p>
                            <p className="text-sm text-muted-foreground">{option.description}</p>
                          </div>
                          <Switch
                            checked={control.enabled}
                            onCheckedChange={(checked) =>
                              updateAttributeControl(option.family, { enabled: checked })
                            }
                          />
                        </div>

                        <div className="space-y-2">
                          <Label className="text-foreground">Retrieval behavior</Label>
                          <Select
                            value={control.mode}
                            onValueChange={(value) =>
                              updateAttributeControl(option.family, {
                                mode: value as RetrievalSettings['attributeControls'][number]['mode'],
                              })
                            }
                            disabled={!control.enabled}
                          >
                            <SelectTrigger className="w-full">
                              <SelectValue placeholder="Select retrieval behavior" />
                            </SelectTrigger>
                            <SelectContent>
                              {Object.entries(attributeModeLabels).map(([value, meta]) => (
                                <SelectItem key={value} value={value}>
                                  {meta.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <p className="text-sm text-muted-foreground">
                            {attributeModeLabels[control.mode].description}
                          </p>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          </SettingsCard>

          <SettingsCard
            icon={<SlidersHorizontal className="h-5 w-5 text-primary" />}
            title="Search Tuning"
            description="Adjust lower-level retrieval thresholds and candidate counts."
          >
            <div className="space-y-4 rounded-md border border-border bg-muted/20 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Advanced</p>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label htmlFor="vectorTopK" className="text-foreground">Vector Top K</Label>
                  <span className="text-sm text-muted-foreground font-mono">{settings.vectorTopK}</span>
                </div>
                <Slider
                  id="vectorTopK"
                  min={1}
                  max={300}
                  step={1}
                  value={[settings.vectorTopK]}
                  onValueChange={([value]) => updateSetting('vectorTopK', value)}
                />
                <p className="text-sm text-muted-foreground">Number of chunks to retrieve from vector search.</p>
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
                <p className="text-sm text-muted-foreground">Minimum similarity score for retrieved chunks.</p>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label htmlFor="rerankTopK" className="text-foreground">Rerank Top K</Label>
                  <span className="text-sm text-muted-foreground font-mono">{settings.rerankTopK}</span>
                </div>
                <Slider
                  id="rerankTopK"
                  min={1}
                  max={50}
                  step={1}
                  value={[settings.rerankTopK]}
                  onValueChange={([value]) => updateSetting('rerankTopK', value)}
                />
                <p className="text-sm text-muted-foreground">Number of chunks to keep after reranking.</p>
              </div>
            </div>
          </SettingsCard>
        </div>
      </div>
    </div>
  )
}
