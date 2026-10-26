'use client'

import { useContext, useState } from 'react'

import { endingNotifiesOperators, ROUTINE_DEFINITION_LIMITS, routineAdvisories } from '@radioso/routine-definition'

import { RoutineInstructionEditor } from '@/components/dashboard/settings/routine-chip-editor'
import { RoutineSkillCatalogContext } from '@/components/dashboard/settings/routine-skill-catalog-popover'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { defaultNoticeDestinationLabel, describeDailyEmailAllowance, describeNoticeDestination } from '@/lib/operator-notice-destinations'
import { instructionToProseParagraphs, proseParagraphsToInstruction } from '@/lib/routine-document'
import { newEndingNotice, replyToCandidates, type EndingNotice } from '@/lib/routine-document-edits'
import { blockSegmentsToInstruction, instructionToBlockSegments, type ChipDocVariable, type ProseParagraph, type RoutineBlockEnding } from '@/lib/routine-prose'

// One notice text, edited with the same chip editor as a step instruction, so `@` inserts a
// collected value as `{{slot.<key>}}`. A notice reads values the routine collects and never
// collects one, so `@` offers only the slots the routine declares: no new slot, no context
// variable. The editor is uncontrolled; it reads the text once, and reports only real edits so
// opening an ending never writes a notice the author did not type.
function NoticeTextField({ label, placeholder, value, variables, maxLength, onChange }: {
  label: string
  placeholder: string
  value: string | null
  variables: ChipDocVariable[]
  maxLength: number
  onChange: (text: string) => void
}) {
  const [initialContent] = useState(() => instructionToProseParagraphs(instructionToBlockSegments(value ?? '')))
  const report = (paragraphs: ProseParagraph[]) => {
    const text = blockSegmentsToInstruction(proseParagraphsToInstruction(paragraphs))
    if (text !== (value ?? '')) onChange(text)
  }
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-foreground">{label}</p>
      <div className="rounded-md border border-input px-2">
        <RoutineInstructionEditor
          initialContent={initialContent}
          variables={variables}
          offerContextVariables={false}
          maxLength={maxLength}
          onChange={report}
          ariaLabel={label}
          placeholder={placeholder}
        />
      </div>
    </div>
  )
}

// A skill name is lower-case letters, digits, and underscores, so this can never name one.
const DEFAULT_SENDER = ':default'

// Which notify skill sends the notice, and who that reaches. The options are the agent's notify
// skills from the routine skill catalog, the same ones validation and delivery accept; a stored
// name the catalog no longer lists stays selectable so the author sees what the routine says.
function NoticeSenderField({ id, skillName, onChange }: {
  id: string
  skillName: string | undefined
  onChange: (skillName: string | null) => void
}) {
  const catalog = useContext(RoutineSkillCatalogContext)
  const notifySkills = catalog.skills.filter((skill) => skill.category === 'notify')
  const unlisted = skillName && !notifySkills.some((skill) => skill.skillName === skillName) ? skillName : null
  // Only a loaded catalog can say a skill is gone; while it loads, or if it failed, the name just shows.
  const catalogLoaded = !catalog.isLoading && !catalog.error
  const destination = describeNoticeDestination(catalog.noticeDestinations, skillName)
  const emailAllowance = describeDailyEmailAllowance(catalog.noticeDestinations)
  return (
    <div className="space-y-1">
      <Label htmlFor={`${id}-sender`} className="text-xs font-medium">Send with</Label>
      <Select value={skillName ?? DEFAULT_SENDER} onValueChange={(value) => onChange(value === DEFAULT_SENDER ? null : value)}>
        <SelectTrigger id={`${id}-sender`} aria-label="Send with" className="h-8">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT_SENDER}>{defaultNoticeDestinationLabel(catalog.noticeDestinations?.default)}</SelectItem>
          {notifySkills.map((skill) => <SelectItem key={skill.skillName} value={skill.skillName}>{skill.displayName}</SelectItem>)}
          {unlisted ? <SelectItem value={unlisted}>{catalogLoaded ? `${unlisted} (unavailable)` : unlisted}</SelectItem> : null}
        </SelectContent>
      </Select>
      {destination ? <p className="text-xs text-muted-foreground">{destination}</p> : null}
      {emailAllowance ? <p className="text-xs text-destructive">{emailAllowance}</p> : null}
    </div>
  )
}

// A slot key starts with a letter or underscore, so this can never name one.
const NO_REPLY_TO = ':none'

// The routine's fields as the reply-to rules read them.
const noticeFields = (variables: ChipDocVariable[]) =>
  variables.map((variable) => ({ key: variable.name, type: variable.type, ...(variable.sensitive ? { sensitivity: 'sensitive' as const } : {}) }))

// Which collected address replies to the notice go to. Only the routine's email fields that are
// not sensitive are offered, and only the author picks one. A stored key that no longer qualifies
// stays visible so the author sees what the routine says; validation reports it.
function NoticeReplyToField({ id, ending, variables, onChange }: {
  id: string
  ending: RoutineBlockEnding
  variables: ChipDocVariable[]
  onChange: (replyToSlot: string | null) => void
}) {
  const replyToSlot = ending.operatorNotice?.replyToSlot
  const fields = noticeFields(variables)
  const emailFields = replyToCandidates(fields)
  const unlisted = replyToSlot && !emailFields.some((field) => field.key === replyToSlot) ? replyToSlot : null
  const unlistedReason = fields.some((field) => field.key === unlisted && field.type === 'email') ? 'sensitive' : 'not an email field'
  const advisories = routineAdvisories({ slots: fields, terminals: [ending] })
  return (
    <div className="space-y-1">
      <Label htmlFor={`${id}-reply-to`} className="text-xs font-medium">Replies go to</Label>
      <Select value={replyToSlot ?? NO_REPLY_TO} onValueChange={(value) => onChange(value === NO_REPLY_TO ? null : value)}>
        <SelectTrigger id={`${id}-reply-to`} aria-label="Replies go to" className="h-8">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_REPLY_TO}>No reply-to</SelectItem>
          {emailFields.map((field) => <SelectItem key={field.key} value={field.key}>{field.key}</SelectItem>)}
          {unlisted ? <SelectItem value={unlisted}>{`${unlisted} (${unlistedReason})`}</SelectItem> : null}
        </SelectContent>
      </Select>
      {advisories.length > 0 ? <p className="text-xs text-muted-foreground">Replies won&apos;t reach the visitor. Choose their email field.</p> : null}
    </div>
  )
}

// What the team is told when the routine ends here. A hand-off always notifies, so its switch
// stays on; a finish notifies only when the author turns it on. Blank text means the default.
export function RoutineEndingNoticeEditor({ ending, variables, onChange }: {
  ending: RoutineBlockEnding
  variables: ChipDocVariable[]
  onChange: (notice: EndingNotice | null) => void
}) {
  const handoff = ending.kind === 'handoff'
  const notice = ending.operatorNotice
  const notifies = endingNotifiesOperators(ending)
  const id = `ending-${ending.stableStepId}-notice`
  const update = (patch: Partial<EndingNotice>) => onChange({ subject: null, intro: null, ...notice, ...patch })
  // The default destination is the absence of a name, so choosing it removes the key.
  const sendWith = (skillName: string | null) => {
    const next: EndingNotice = { subject: null, intro: null, ...notice }
    if (skillName) next.skillName = skillName
    else delete next.skillName
    onChange(next)
  }
  // No reply-to is the absence of a key, the same way.
  const replyTo = (replyToSlot: string | null) => {
    const next: EndingNotice = { subject: null, intro: null, ...notice }
    if (replyToSlot) next.replyToSlot = replyToSlot
    else delete next.replyToSlot
    onChange(next)
  }
  const includeAiSummary = (checked: boolean) => update({ includeAiSummary: checked })

  return (
    <div className="w-full space-y-2 rounded-md border border-border p-3">
      <div className="flex items-center gap-2">
        <Switch
          id={`${id}-enabled`}
          checked={notifies}
          disabled={handoff}
          onCheckedChange={(checked) => onChange(checked ? newEndingNotice(noticeFields(variables)) : null)}
        />
        <Label htmlFor={`${id}-enabled`} className="text-sm">Notify the team</Label>
        {handoff ? <span className="text-xs text-muted-foreground">Always on for a hand-off.</span> : null}
      </div>
      {notifies ? (
        <div className="space-y-2">
          <NoticeSenderField id={id} skillName={notice?.skillName} onChange={sendWith} />
          <NoticeReplyToField id={id} ending={ending} variables={variables} onChange={replyTo} />
          <NoticeTextField
            label="Subject"
            placeholder="Default subject. Type @ to insert a value."
            value={notice?.subject ?? null}
            variables={variables}
            maxLength={ROUTINE_DEFINITION_LIMITS.operatorNoticeSubject}
            onChange={(subject) => update({ subject })}
          />
          <NoticeTextField
            label="Intro"
            placeholder="Optional. Type @ to insert a value."
            value={notice?.intro ?? null}
            variables={variables}
            maxLength={ROUTINE_DEFINITION_LIMITS.operatorNoticeIntro}
            onChange={(intro) => update({ intro })}
          />
          <div className="flex items-center gap-2">
            <Switch id={`${id}-ai-summary`} checked={notice?.includeAiSummary === true} onCheckedChange={includeAiSummary} />
            <Label htmlFor={`${id}-ai-summary`} className="text-sm">Include AI summary</Label>
          </div>
          <p className="text-xs text-muted-foreground">Adds a background summary of details not captured in the collected values.</p>
          <p className="text-xs text-muted-foreground">Every collected value is listed below the intro.</p>
        </div>
      ) : null}
    </div>
  )
}
