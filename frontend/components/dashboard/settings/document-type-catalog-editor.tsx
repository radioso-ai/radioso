'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Plus, Tags, Trash2 } from 'lucide-react'

import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { SettingTooltip } from '@/components/dashboard/settings/settings-flow'
import { ingestionSettingDocs } from '@/components/dashboard/settings/settings-docs'
import {
  CATALOG_CONFLICT_MESSAGE,
  DOCUMENT_TYPE_CATALOG_LIMITS,
  createFieldDraft,
  createTypeDraft,
  documentTypeFieldValueTypeLabels,
  documentTypeFieldValueTypes,
  isCatalogConflict,
  issuesForField,
  issuesForType,
  referencedKeysLosingExtraction,
  toCatalogDraft,
  toCatalogUpdateRequest,
  validateCatalogDraft,
  type DocumentTypeCatalogDraft,
  type DocumentTypeDraft,
  type DocumentTypeFieldDraft,
} from '@/components/dashboard/settings/document-type-catalog-model'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { settingsApi } from '@/lib/api'
import { getApiErrorMessage, getApiErrorStatus } from '@/lib/api-error'
import type { DocumentTypeFieldValueType } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'

type PendingDeletion =
  | { kind: 'type'; typeRowId: string; label: string }
  | { kind: 'field'; typeRowId: string; fieldRowId: string; fieldKey: string }

export function DocumentTypeCatalogEditor() {
  const { activeWorkspaceId, isLoading: isWorkspaceLoading } = useWorkspace()
  const [draft, setDraft] = useState<DocumentTypeCatalogDraft | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [conflictMessage, setConflictMessage] = useState<string | null>(null)
  const [savedMessage, setSavedMessage] = useState<string | null>(null)
  const [pendingDeletion, setPendingDeletion] = useState<PendingDeletion | null>(null)
  const [advisoryKeys, setAdvisoryKeys] = useState<string[] | null>(null)
  const loadSequenceRef = useRef(0)

  const loadCatalog = useCallback(async () => {
    const loadId = loadSequenceRef.current + 1
    loadSequenceRef.current = loadId
    const catalog = await settingsApi.getDocumentTypeCatalog()
    if (loadSequenceRef.current !== loadId) {
      return null
    }
    const next = toCatalogDraft(catalog)
    setDraft(next)
    return next
  }, [])

  useEffect(() => {
    if (isWorkspaceLoading || !activeWorkspaceId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Workspace changes reset this async panel to loading.
      setIsLoading(true)
      return
    }

    let active = true
    const run = async () => {
      try {
        await loadCatalog()
      } catch (error) {
        if (!active) return
        console.error('Failed to load the document type catalog:', error)
        setSaveError(getApiErrorMessage(error, 'Failed to load document types.'))
      } finally {
        if (active) {
          setIsLoading(false)
        }
      }
    }
    void run()
    return () => {
      active = false
    }
  }, [activeWorkspaceId, isWorkspaceLoading, loadCatalog])

  const issues = useMemo(() => (draft ? validateCatalogDraft(draft) : []), [draft])
  const catalogIssues = issues.filter((issue) => issue.scope === 'catalog')

  const updateDraft = (updater: (current: DocumentTypeCatalogDraft) => DocumentTypeCatalogDraft) => {
    setSavedMessage(null)
    setDraft((current) => (current ? updater(current) : current))
  }

  const updateType = (typeRowId: string, updates: Partial<DocumentTypeDraft>) => {
    updateDraft((current) => ({
      ...current,
      operatorTypes: current.operatorTypes.map((type) =>
        type.rowId === typeRowId ? { ...type, ...updates } : type,
      ),
    }))
  }

  const updateField = (
    typeRowId: string,
    fieldRowId: string,
    updates: Partial<DocumentTypeFieldDraft>,
  ) => {
    updateDraft((current) => ({
      ...current,
      operatorTypes: current.operatorTypes.map((type) =>
        type.rowId === typeRowId
          ? {
              ...type,
              fields: type.fields.map((field) =>
                field.rowId === fieldRowId ? { ...field, ...updates } : field,
              ),
            }
          : type,
      ),
    }))
  }

  const addType = () => {
    updateDraft((current) => ({
      ...current,
      operatorTypes: [...current.operatorTypes, createTypeDraft()],
    }))
  }

  const addField = (typeRowId: string) => {
    updateDraft((current) => ({
      ...current,
      operatorTypes: current.operatorTypes.map((type) =>
        type.rowId === typeRowId ? { ...type, fields: [...type.fields, createFieldDraft()] } : type,
      ),
    }))
  }

  const removeType = (typeRowId: string) => {
    updateDraft((current) => ({
      ...current,
      operatorTypes: current.operatorTypes.filter((type) => type.rowId !== typeRowId),
    }))
  }

  const removeField = (typeRowId: string, fieldRowId: string) => {
    updateDraft((current) => ({
      ...current,
      operatorTypes: current.operatorTypes.map((type) =>
        type.rowId === typeRowId
          ? { ...type, fields: type.fields.filter((field) => field.rowId !== fieldRowId) }
          : type,
      ),
    }))
  }

  const setBuiltInEnabled = (typeKey: string, enabled: boolean) => {
    updateDraft((current) => ({
      ...current,
      disabledBuiltInTypeKeys: enabled
        ? current.disabledBuiltInTypeKeys.filter((key) => key !== typeKey)
        : [...current.disabledBuiltInTypeKeys, typeKey],
    }))
  }

  const requestFieldRemoval = (type: DocumentTypeDraft, field: DocumentTypeFieldDraft) => {
    if (!field.persisted) {
      removeField(type.rowId, field.rowId)
      return
    }
    setPendingDeletion({ kind: 'field', typeRowId: type.rowId, fieldRowId: field.rowId, fieldKey: field.key })
  }

  const requestTypeRemoval = (type: DocumentTypeDraft) => {
    if (!type.persisted) {
      removeType(type.rowId)
      return
    }
    setPendingDeletion({ kind: 'type', typeRowId: type.rowId, label: type.label || type.key })
  }

  const confirmDeletion = () => {
    if (!pendingDeletion) return
    if (pendingDeletion.kind === 'field') {
      removeField(pendingDeletion.typeRowId, pendingDeletion.fieldRowId)
    } else {
      removeType(pendingDeletion.typeRowId)
    }
    setPendingDeletion(null)
  }

  const persist = async () => {
    if (!draft) return
    setIsSaving(true)
    setSaveError(null)
    setConflictMessage(null)
    try {
      const saved = await settingsApi.updateDocumentTypeCatalog(toCatalogUpdateRequest(draft))
      setDraft(toCatalogDraft(saved))
      setSavedMessage('Document types saved. New processing runs use them; use Reprocess source to apply them to documents you already have.')
    } catch (error) {
      if (isCatalogConflict(getApiErrorStatus(error))) {
        setConflictMessage(CATALOG_CONFLICT_MESSAGE)
        try {
          await loadCatalog()
        } catch (reloadError) {
          setSaveError(getApiErrorMessage(reloadError, 'Failed to reload document types.'))
        }
        return
      }
      setSaveError(getApiErrorMessage(error, 'Failed to save document types.'))
    } finally {
      setIsSaving(false)
    }
  }

  const handleSave = () => {
    if (!draft || issues.length > 0) {
      return
    }
    const atRisk = referencedKeysLosingExtraction(draft)
    if (atRisk.length > 0) {
      setAdvisoryKeys(atRisk)
      return
    }
    void persist()
  }

  if (isLoading) {
    return (
      <SettingsCard
        id="document-types"
        icon={<Tags className="h-5 w-5 text-primary" />}
        title={ingestionSettingDocs.documentTypes.label}
        description={ingestionSettingDocs.documentTypes.summary}
      >
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Loading document types…
        </div>
      </SettingsCard>
    )
  }

  if (!draft) {
    return (
      <SettingsCard
        id="document-types"
        icon={<Tags className="h-5 w-5 text-primary" />}
        title={ingestionSettingDocs.documentTypes.label}
        description={ingestionSettingDocs.documentTypes.summary}
      >
        <p className="text-sm text-muted-foreground">Failed to load document types.</p>
      </SettingsCard>
    )
  }

  return (
    <SettingsCard
      id="document-types"
      icon={<Tags className="h-5 w-5 text-primary" />}
      title={ingestionSettingDocs.documentTypes.label}
      description={ingestionSettingDocs.documentTypes.summary}
      headerEnd={
        <SettingTooltip
          label={ingestionSettingDocs.documentTypes.label}
          content={ingestionSettingDocs.documentTypes.details}
        />
      }
    >
      <div className="space-y-6" data-testid="document-type-catalog">
        <p className="text-sm text-muted-foreground">
          Extraction runs once per document while metadata extraction is on, classifying the page against
          these types and pulling out the fields the matched type declares. Changes here apply to
          processing that happens after you save; <strong>Reprocess source</strong> applies them to
          documents a source already ingested.
        </p>

        <div className="space-y-3">
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Built-in types
          </p>
          <div className="space-y-2">
            {draft.builtInTypes.map((type) => {
              const enabled = !draft.disabledBuiltInTypeKeys.includes(type.key)
              return (
                <div
                  key={type.key}
                  className="flex items-start justify-between gap-4 rounded-md border border-border/70 bg-muted/15 p-3.5"
                  data-testid={`built-in-type-${type.key}`}
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium text-foreground">{type.label}</p>
                      <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        {type.key}
                      </code>
                    </div>
                    <p className="text-sm text-muted-foreground">{type.description}</p>
                    {type.fields.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {type.fields.map((field) => (
                          <span
                            key={field.key}
                            className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                          >
                            {field.key} · {documentTypeFieldValueTypeLabels[field.valueType]}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  {type.disableable ? (
                    <Switch
                      checked={enabled}
                      aria-label={`Classify documents as ${type.label}`}
                      onCheckedChange={(checked) => setBuiltInEnabled(type.key, checked)}
                    />
                  ) : (
                    <p className="shrink-0 text-xs text-muted-foreground">Always on — the fallback</p>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        <div className="space-y-3 border-t border-border/70 pt-4">
          <div className="flex items-center justify-between gap-4">
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
              Your types
            </p>
            <Button type="button" variant="outline" size="sm" onClick={addType}>
              <Plus className="mr-2 h-4 w-4" />
              Add document type
            </Button>
          </div>

          {draft.operatorTypes.length === 0 ? (
            <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
              No document types of your own yet. Add one when your content has a shape the built-ins do
              not describe — a product page, a course listing, a job posting.
            </div>
          ) : (
            <div className="space-y-4">
              {draft.operatorTypes.map((type) => {
                const typeIssues = issuesForType(issues, type.rowId)
                return (
                  <div
                    key={type.rowId}
                    className="space-y-4 rounded-md border border-border/70 bg-muted/15 p-3.5"
                    data-testid="operator-type"
                  >
                    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
                      <div className="space-y-2">
                        <Label htmlFor={`type-label-${type.rowId}`} className="text-foreground">
                          Label
                        </Label>
                        <Input
                          id={`type-label-${type.rowId}`}
                          value={type.label}
                          placeholder="Product"
                          onChange={(event) => updateType(type.rowId, { label: event.target.value })}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor={`type-key-${type.rowId}`} className="text-foreground">
                          Key
                        </Label>
                        <Input
                          id={`type-key-${type.rowId}`}
                          value={type.key}
                          disabled={type.persisted}
                          placeholder="product"
                          onChange={(event) => updateType(type.rowId, { key: event.target.value })}
                        />
                        {type.persisted ? (
                          <p className="text-xs text-muted-foreground">
                            Provenance refers to a type by its key, so the key stays as created.
                          </p>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-2 pb-1">
                        <Switch
                          checked={type.enabled}
                          aria-label={`Classify documents as ${type.label || type.key || 'this type'}`}
                          onCheckedChange={(checked) => updateType(type.rowId, { enabled: checked })}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Delete document type ${type.label || type.key}`}
                          onClick={() => requestTypeRemoval(type)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-3">
                        <Label htmlFor={`type-description-${type.rowId}`} className="text-foreground">
                          What this kind of page looks like
                        </Label>
                        <span className="text-xs text-muted-foreground">
                          {type.description.length}/{DOCUMENT_TYPE_CATALOG_LIMITS.maxDescriptionChars}
                        </span>
                      </div>
                      <Textarea
                        id={`type-description-${type.rowId}`}
                        value={type.description}
                        rows={3}
                        placeholder="A product detail page: one purchasable item, with a price and availability."
                        onChange={(event) => updateType(type.rowId, { description: event.target.value })}
                      />
                      <p className="text-xs text-muted-foreground">
                        Plain prose, in any language your documents use — this is what the model classifies
                        against.
                      </p>
                    </div>

                    <div className="space-y-3 border-t border-border/60 pt-3">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-sm font-medium text-foreground">Fields</p>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => addField(type.rowId)}
                        >
                          <Plus className="mr-2 h-4 w-4" />
                          Add field
                        </Button>
                      </div>

                      {type.fields.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          No fields yet. A type with no fields still classifies documents; add fields to
                          pull values out of them.
                        </p>
                      ) : null}

                      {type.fields.map((field) => {
                        const fieldIssues = issuesForField(issues, field.rowId)
                        return (
                          <div
                            key={field.rowId}
                            className="space-y-2 rounded-md border border-border/60 bg-background/40 p-3"
                            data-testid="operator-type-field"
                          >
                            <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)_auto]">
                              <div className="space-y-2">
                                <Label htmlFor={`field-key-${field.rowId}`} className="text-foreground">
                                  Key
                                </Label>
                                <Input
                                  id={`field-key-${field.rowId}`}
                                  value={field.key}
                                  disabled={field.persisted}
                                  placeholder="price"
                                  onChange={(event) =>
                                    updateField(type.rowId, field.rowId, { key: event.target.value })
                                  }
                                />
                              </div>
                              <div className="space-y-2">
                                <Label htmlFor={`field-label-${field.rowId}`} className="text-foreground">
                                  Label
                                </Label>
                                <Input
                                  id={`field-label-${field.rowId}`}
                                  value={field.label}
                                  placeholder="Price"
                                  onChange={(event) =>
                                    updateField(type.rowId, field.rowId, { label: event.target.value })
                                  }
                                />
                              </div>
                              <div className="space-y-2">
                                <Label className="text-foreground">Value type</Label>
                                <Select
                                  value={field.valueType}
                                  disabled={field.persisted}
                                  onValueChange={(value) =>
                                    updateField(type.rowId, field.rowId, {
                                      valueType: value as DocumentTypeFieldValueType,
                                    })
                                  }
                                >
                                  <SelectTrigger
                                    className="w-full"
                                    aria-label={`Value type for ${field.key || 'new field'}`}
                                  >
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {documentTypeFieldValueTypes.map((valueType) => (
                                      <SelectItem key={valueType} value={valueType}>
                                        {documentTypeFieldValueTypeLabels[valueType]}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                              <div className="flex items-end pb-1">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  aria-label={`Delete field ${field.key || 'new field'}`}
                                  onClick={() => requestFieldRemoval(type, field)}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            </div>

                            <div className="space-y-2">
                              <div className="flex items-center justify-between gap-3">
                                <Label
                                  htmlFor={`field-instruction-${field.rowId}`}
                                  className="text-foreground"
                                >
                                  What to extract
                                </Label>
                                <span className="text-xs text-muted-foreground">
                                  {field.instruction.length}/
                                  {DOCUMENT_TYPE_CATALOG_LIMITS.maxInstructionChars}
                                </span>
                              </div>
                              <Input
                                id={`field-instruction-${field.rowId}`}
                                value={field.instruction}
                                placeholder="The listed price as a number, without a currency symbol."
                                onChange={(event) =>
                                  updateField(type.rowId, field.rowId, { instruction: event.target.value })
                                }
                              />
                            </div>

                            {field.persisted ? (
                              <p className="text-xs text-muted-foreground">
                                Key and value type are fixed once saved. To change either, delete this field
                                and create a new key.
                              </p>
                            ) : null}

                            {fieldIssues.map((issue) => (
                              <p key={issue.message} className="text-sm text-destructive">
                                {issue.message}
                              </p>
                            ))}
                          </div>
                        )
                      })}
                    </div>

                    {typeIssues.map((issue) => (
                      <p key={issue.message} className="text-sm text-destructive">
                        {issue.message}
                      </p>
                    ))}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {catalogIssues.map((issue) => (
          <p key={issue.message} className="text-sm text-destructive">
            {issue.message}
          </p>
        ))}

        {conflictMessage ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-foreground"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <span>{conflictMessage}</span>
          </div>
        ) : null}

        {saveError ? <p className="text-sm text-destructive" role="alert">{saveError}</p> : null}

        <div className="flex items-center gap-3 border-t border-border/70 pt-4">
          <Button type="button" onClick={handleSave} disabled={isSaving || issues.length > 0}>
            {isSaving ? <Spinner className="mr-2" /> : null}
            Save document types
          </Button>
          {savedMessage ? <p className="text-sm text-muted-foreground">{savedMessage}</p> : null}
        </div>
      </div>

      <AlertDialog
        open={pendingDeletion !== null}
        onOpenChange={(open) => (open ? null : setPendingDeletion(null))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingDeletion?.kind === 'field' ? 'Delete this field?' : 'Delete this document type?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDeletion?.kind === 'field'
                ? `Saving removes "${pendingDeletion.fieldKey}" from future extraction, and drops the tag from each document on its next reprocess. The key is retired: it can only ever come back as the same value type.`
                : `Saving removes "${pendingDeletion?.kind === 'type' ? pendingDeletion.label : ''}" from classification. Its field keys are retired, and tags already on documents stay until those documents are reprocessed.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => {
                event.preventDefault()
                confirmDeletion()
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={advisoryKeys !== null}
        onOpenChange={(open) => (open ? null : setAdvisoryKeys(null))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Agent rules point at these fields</AlertDialogTitle>
            <AlertDialogDescription>
              {`Metadata rules on ${(advisoryKeys ?? []).join(', ')} keep working, but stop matching once these keys are no longer extracted — the same as any absent tag. Update those rules when you get a chance.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault()
                setAdvisoryKeys(null)
                void persist()
              }}
            >
              Save anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsCard>
  )
}
