'use client'

import { useCallback, useContext, useEffect, useMemo, useRef, type JSX } from 'react'

import { Database } from 'lucide-react'

import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  COMMAND_PRIORITY_CRITICAL,
  INSERT_LINE_BREAK_COMMAND,
  INSERT_PARAGRAPH_COMMAND,
  type EditorState,
} from 'lexical'

import { ChipNode } from '@/components/dashboard/settings/routine-chip-node'
import { ChipTypeaheadPlugin } from '@/components/dashboard/settings/routine-chip-typeahead-plugin'
import { $initializeFromParagraphs, $readProseParagraphs } from '@/components/dashboard/settings/routine-prose-nodes'
import { RoutineSkillCatalogContext } from '@/components/dashboard/settings/routine-skill-catalog-popover'
import { SkillPickerMenu } from '@/components/dashboard/settings/skill-picker-menu'
import { useInsertSkillChip } from '@/components/dashboard/settings/use-insert-skill-chip'
import { Button } from '@/components/ui/button'
import type { SkillAuthoringDescriptor } from '@/lib/api-routine-skill-catalog'
import { parseProseDoc, tokenForChip, type ProseParagraph, type ProseSegment } from '@/lib/routine-prose'
import { cn } from '@/lib/utils'

// What a mention surface needs to know about a skill: who it is. A mention names a capability;
// it does not run it as a routine step.
export type SkillMentionOption = {
  skillName: string
  displayName: string
  description?: string
}

// A value with no declared mentions is the common case (a new directive, or one that only steers
// wording), so it gets a stable empty rather than a fresh literal per render.
const NO_RECOGNIZED_SKILLS: readonly string[] = []

// The chip and its popover read the routine-authoring catalog contract, whose step metadata
// (category, typed ports, outcomes) no mention surface renders. It is filled with the empty
// shape rather than invented per skill.
const mentionDescriptor = (option: SkillMentionOption): SkillAuthoringDescriptor => ({
  skillName: option.skillName,
  displayName: option.displayName,
  ...(option.description ? { description: option.description } : {}),
  category: 'external_mcp',
  inputs: [],
  outcomes: [],
  hasDataOutputs: false,
})

// One line of the stored value → its editable segments. Only `#` marks a skill on a mention
// surface, so every other token the routine grammar recognises — a slot, a branch target, a
// guard, a step title — goes back in as the literal characters the author wrote. A `#name` the
// host did not declare gets the same treatment: `tokenForChip` rebuilds it with its binding
// suffix intact, so nothing the author typed is dropped on the way back to text.
const toMentionParagraph = (paragraph: ProseParagraph, isRecognized: (skillName: string) => boolean): ProseParagraph => {
  const segments: ProseSegment[] = []
  const pushText = (text: string) => {
    if (!text) return
    const last = segments[segments.length - 1]
    if (last && last.kind === 'text') last.text += text
    else segments.push({ kind: 'text', text })
  }
  if (paragraph.headingLevel === 1) pushText('# ')
  for (const segment of paragraph.segments) {
    if (segment.kind === 'text') pushText(segment.text)
    else if (segment.chipKind === 'skill' && isRecognized(segment.refId)) segments.push(segment)
    else pushText(tokenForChip(segment))
  }
  return { segments: segments.length > 0 ? segments : [{ kind: 'text', text: '' }] }
}

// A bare `@name` is never a skill here: `#` is the only skill marker, so an address or a
// handle in the prose stays prose instead of silently becoming a binding. `#name` is not enough
// either — the grammar reads every `#<identifier>` as a skill, so the host says which names this
// value actually carries as mentions and the rest stays prose.
const parseSkillMentionValue = (value: string, recognizedSkillNames: readonly string[]): ProseParagraph[] => {
  const recognized = new Set(recognizedSkillNames)
  return parseProseDoc(value, () => false).paragraphs.map((paragraph) =>
    toMentionParagraph(paragraph, (skillName) => recognized.has(skillName)),
  )
}

const serializeSkillMentionValue = (paragraphs: ProseParagraph[]): string =>
  paragraphs
    .map((paragraph) => paragraph.segments.map((segment) => (segment.kind === 'text' ? segment.text : tokenForChip(segment))).join(''))
    .join('\n')

const mentionedSkills = (paragraphs: ProseParagraph[]): string[] => {
  const names: string[] = []
  for (const paragraph of paragraphs) {
    for (const segment of paragraph.segments) {
      if (segment.kind === 'chip' && segment.chipKind === 'skill') names.push(segment.refId)
    }
  }
  return names
}

// The skills a stored value mentions, without mounting an editor — so a host can ask the same
// question the editor answers. `recognizedSkillNames` is the host's declaration of which
// mentions this value carries; a `#word` outside it is prose and is never reported.
export const readSkillMentions = (value: string, recognizedSkillNames: readonly string[] = []): string[] =>
  mentionedSkills(parseSkillMentionValue(value, recognizedSkillNames))

// What the editor will hold for a seed. Seeding must not rewrite the stored value: everything
// that does not become a chip comes back as the characters it was written with.
export const seedSkillMentionValue = (value: string, recognizedSkillNames: readonly string[] = []): string =>
  serializeSkillMentionValue(parseSkillMentionValue(value, recognizedSkillNames))

// Whether the text already writes `#skillName` as a mention, so a caller that would append the
// name can tell whether that would duplicate one the author already wrote.
//
// It asks the parser, because "where does a mention token end" has exactly one right answer and a
// second implementation of it drifts. It drifted once already: a hand-written continuation class
// that omitted `.` and `-` read `#issue_refund-tier2` as a mention of `issue_refund`, so the host
// skipped the append, the chip never seeded, and the editor's mount emit cleared the binding on a
// save the operator saw as a no-op. Declaring the asked-about name as recognized removes the only
// thing the parse adds — policy — and leaves the fact about the text.
//
// The invariant, covered by tests: `mentionsSkill(value, name)` is true exactly when
// `readSkillMentions(value, [name])` contains `name`.
export const mentionsSkill = (value: string, skillName: string): boolean =>
  skillName !== '' && readSkillMentions(value, [skillName]).includes(skillName)

// The field holds one logical line: Enter selects from the mention menu, it never splits the
// value into a second paragraph.
function SingleLinePlugin(): null {
  const [editor] = useLexicalComposerContext()
  useEffect(() => {
    const block = () => true
    const unregisterParagraph = editor.registerCommand(INSERT_PARAGRAPH_COMMAND, block, COMMAND_PRIORITY_CRITICAL)
    const unregisterLineBreak = editor.registerCommand(INSERT_LINE_BREAK_COMMAND, block, COMMAND_PRIORITY_CRITICAL)
    return () => {
      unregisterParagraph()
      unregisterLineBreak()
    }
  }, [editor])
  return null
}

function SkillMentionBrowseButton({
  skillMenuNotice,
  skillMenuEmptyMessage,
  isSkillsLoading,
  skillLoadError,
  onCreateSkill,
}: {
  skillMenuNotice: string | null
  skillMenuEmptyMessage: string | null
  isSkillsLoading: boolean
  skillLoadError: string | null
  onCreateSkill?: (typedName: string) => Promise<string | null>
}): JSX.Element {
  const skillCatalog = useContext(RoutineSkillCatalogContext)
  const insertSkillChip = useInsertSkillChip()
  const groups = useMemo(
    () => skillMenuNotice ? [] : [{
      key: 'skills',
      skills: skillCatalog.skills.map((skill) => ({ skillName: skill.skillName, displayName: skill.displayName })),
    }],
    [skillCatalog.skills, skillMenuNotice],
  )

  return (
    <div className="absolute right-1 top-1">
      <SkillPickerMenu
        groups={groups}
        emptyMessage={skillMenuNotice ?? skillMenuEmptyMessage ?? 'No skills available.'}
        isLoading={!skillMenuNotice && isSkillsLoading}
        error={skillMenuNotice ? null : skillLoadError}
        // No typed name to seed from here, so the form falls back to its suggested one.
        createAction={onCreateSkill && !skillMenuNotice
          ? {
            label: 'Add a new skill...',
            onSelect: () => {
              void onCreateSkill('').then((createdName) => {
                if (createdName) insertSkillChip({ skillName: createdName })
              })
            },
          }
          : null}
        onSelect={(skillName) => {
          const skill = skillCatalog.skills.find((candidate) => candidate.skillName === skillName)
          if (skill) insertSkillChip({ skillName: skill.skillName, displayName: skill.displayName, focusEditor: true })
        }}
      >
        <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2" aria-label="Browse skills">
          <Database className="h-4 w-4" />
          Skill
        </Button>
      </SkillPickerMenu>
    </div>
  )
}

function MentionChangePlugin({
  onChange,
  onSkillsChange,
}: {
  onChange: (value: string) => void
  onSkillsChange?: (skillNames: string[]) => void
}): JSX.Element {
  const [editor] = useLexicalComposerContext()
  // Handlers are read through a ref so the mount emit registers once. A host that rebuilds its
  // callbacks each render would otherwise re-emit forever.
  const handlersRef = useRef({ onChange, onSkillsChange })
  useEffect(() => {
    handlersRef.current = { onChange, onSkillsChange }
  })
  const lastEmittedRef = useRef<string | null>(null)

  const emit = useCallback((editorState: EditorState) => {
    editorState.read(() => {
      const paragraphs = $readProseParagraphs()
      const value = serializeSkillMentionValue(paragraphs)
      const skillNames = mentionedSkills(paragraphs)
      const signature = `${skillNames.join(' ')}${value}`
      if (lastEmittedRef.current === signature) return
      lastEmittedRef.current = signature
      handlersRef.current.onChange(value)
      handlersRef.current.onSkillsChange?.(skillNames)
    })
  }, [])

  // Lexical's change handler ignores the initial state, so seed the host from exactly what the
  // editor parsed.
  useEffect(() => {
    emit(editor.getEditorState())
  }, [editor, emit])

  return <OnChangePlugin onChange={emit} />
}

// A one-line prose field where `#` inserts a skill chip. The value is the portable text the
// grammar produces (`Refund the order using #issue_refund`), so it round-trips through
// ordinary API string fields.
export function SkillMentionInput({
  id,
  ariaLabel,
  ariaInvalid = false,
  placeholder,
  value,
  recognizedSkillNames = NO_RECOGNIZED_SKILLS,
  skills,
  skillMenuNotice = null,
  skillMenuEmptyMessage = null,
  isSkillsLoading = false,
  skillLoadError = null,
  onChange,
  onSkillsChange,
  onCreateSkill,
}: {
  id?: string
  ariaLabel: string
  // The editable surface is the control, so a host reporting a validation error has to mark it
  // here rather than on the bordered wrapper around it.
  ariaInvalid?: boolean
  placeholder?: string
  // Seeds the editor on mount; the editor owns the text from then on and reports it back.
  value: string
  // Which `#name` occurrences in `value` are mentions rather than prose — for a directive, the
  // one name its `binding` holds. The binding is the source of truth; the prose is not. Without
  // this the grammar would promote any `#word` in the seed to a chip and hand the host back a
  // binding nobody authored. Chips inserted through the `#` menu are built as nodes and never
  // re-parsed, so they need no declaration.
  recognizedSkillNames?: readonly string[]
  skills: SkillMentionOption[]
  // Shown in place of the skill choices when the host has already bound all it can hold.
  skillMenuNotice?: string | null
  // Explains an empty catalog for this binding surface without changing routine editor copy.
  skillMenuEmptyMessage?: string | null
  isSkillsLoading?: boolean
  skillLoadError?: string | null
  onChange: (value: string) => void
  onSkillsChange?: (skillNames: string[]) => void
  // Offers to author a name the catalog lacks. Resolves to the created skill's name, or null when
  // the author backs out. Omitted, an uncatalogued name simply is not offered.
  onCreateSkill?: (typedName: string) => Promise<string | null>
}): JSX.Element {
  // Read once, on mount: the seed is the stored value and its declared mentions, and the editor
  // owns both from then on.
  const seedRef = useRef({ value, recognizedSkillNames })
  const catalog = useMemo(
    () => ({ agentId: '', skills: skills.map(mentionDescriptor), isLoading: isSkillsLoading, error: skillLoadError }),
    [isSkillsLoading, skillLoadError, skills],
  )

  return (
    <LexicalComposer
      initialConfig={{
        namespace: 'skill-mention-input',
        nodes: [ChipNode],
        onError: (error: Error) => {
          throw error
        },
        theme: {},
        editorState: () =>
          $initializeFromParagraphs(parseSkillMentionValue(seedRef.current.value, seedRef.current.recognizedSkillNames)),
      }}
    >
      <RoutineSkillCatalogContext.Provider value={catalog}>
        <div className="routine-prose-surface relative rounded-md border border-input bg-transparent focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
          <RichTextPlugin
            contentEditable={
              <ContentEditable
                id={id}
                aria-label={ariaLabel}
                aria-invalid={ariaInvalid}
                className={cn('min-h-9 w-full px-3 py-2 pr-20 text-sm outline-none [&_p]:my-0')}
              />
            }
            placeholder={() =>
              placeholder ? (
                <div className="pointer-events-none absolute left-3 top-2 text-sm text-muted-foreground">{placeholder}</div>
              ) : null
            }
            ErrorBoundary={LexicalErrorBoundary}
          />
          <HistoryPlugin />
          <SingleLinePlugin />
          <MentionChangePlugin onChange={onChange} onSkillsChange={onSkillsChange} />
          <ChipTypeaheadPlugin
            skillsOnly
            skillMenuNotice={skillMenuNotice}
            skillMenuEmptyMessage={isSkillsLoading || skillLoadError ? null : skillMenuEmptyMessage}
            onCreateSkill={onCreateSkill}
          />
          <SkillMentionBrowseButton
            skillMenuNotice={skillMenuNotice}
            skillMenuEmptyMessage={skillMenuEmptyMessage}
            isSkillsLoading={isSkillsLoading}
            skillLoadError={skillLoadError}
            onCreateSkill={onCreateSkill}
          />
        </div>
      </RoutineSkillCatalogContext.Provider>
    </LexicalComposer>
  )
}
