'use client'

import {
  AlertTriangle,
  CheckCircle2,
  FlaskConical,
  MoreHorizontal,
  Pause,
  Play,
  Trash2,
  WandSparkles,
  Waypoints,
  X,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export type RoutineValidationStatus = 'checking' | 'invalid' | 'valid'

function RoutineValidationStatusIcon({ state }: { state: RoutineValidationStatus }) {
  const label = state === 'valid'
    ? 'Routine valid'
    : state === 'invalid'
      ? 'Routine has validation issues'
      : 'Checking routine'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="status"
          aria-label={label}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground"
        >
          {state === 'valid' ? <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" /> : null}
          {state === 'invalid' ? <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" /> : null}
          {state === 'checking' ? <Spinner className="h-4 w-4" /> : null}
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

type RoutineEditorHeaderProps = {
  name: string
  onNameChange: (name: string) => void
  enabled: boolean
  onToggleEnabled: () => void
  isToggling: boolean
  canTest: boolean
  onTest: () => void
  isPersisted: boolean
  isSaving: boolean
  isDrafting: boolean
  validationStatus: RoutineValidationStatus
  // Omitted (no "Map" item) when there is no active draft graph for it to show.
  onOpenMap?: () => void
  onOpenDraftAssist: () => void
  onDelete: () => void
  onBack: () => void
  // The icon, overflow menu, and publish/pause button wait for the form to finish loading;
  // the name field and status pill do not — matching the original inline header's own gating.
  showActions: boolean
}

// The routine editor's own header row — name, Live/Draft status, and every action the routine
// itself offers (test, publish/pause, overflow menu, close) — split from
// assistant-routines-section.tsx so that file stays about the routine *form*, not the chrome
// around it. The page shell's header registers title and actions as two separate slots (see
// `useRegisterRoutineHeader`), so this is one component rendered twice, `slot` picking which
// half — not two independent components that could drift out of sync with each other's view
// of the routine, since both calls share the exact same prop bag.
export function RoutineEditorHeader({ slot, ...props }: RoutineEditorHeaderProps & { slot: 'title' | 'actions' }) {
  return slot === 'title' ? <RoutineEditorHeaderTitle {...props} /> : <RoutineEditorHeaderActions {...props} />
}

function RoutineEditorHeaderTitle({ name, onNameChange, enabled }: Pick<RoutineEditorHeaderProps, 'name' | 'onNameChange' | 'enabled'>) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      {/* The routine's own name is the page title, edited in place; nothing else in this row
          owns "Name" as a label, so the accessible name stays on the field itself. */}
      <input
        id="routineName"
        aria-label="Name"
        value={name}
        onChange={(event) => onNameChange(event.target.value)}
        placeholder="Untitled routine"
        className="w-full min-w-0 max-w-md truncate border-b border-dashed border-muted-foreground/30 bg-transparent text-lg font-medium leading-none text-foreground outline-none placeholder:text-muted-foreground/60 hover:border-muted-foreground/60 focus:border-foreground focus:outline-none"
      />
      <Badge
        variant={enabled ? 'default' : 'secondary'}
        className={enabled
          ? 'shrink-0 border-transparent bg-emerald-500/15 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400'
          : 'shrink-0 border-transparent bg-muted text-muted-foreground'}
      >
        {enabled ? 'Live' : 'Draft'}
      </Badge>
    </span>
  )
}

function RoutineEditorHeaderActions({
  enabled,
  onToggleEnabled,
  isToggling,
  canTest,
  onTest,
  isPersisted,
  isSaving,
  isDrafting,
  validationStatus,
  onOpenMap,
  onOpenDraftAssist,
  onDelete,
  onBack,
  showActions,
}: Omit<RoutineEditorHeaderProps, 'name' | 'onNameChange'>) {
  return (
    // Editing is autosaved, so the header carries no save action. "Test" is the one
    // affordance the routine itself offers beyond the publish toggle; AI drafting and delete
    // live in an overflow menu so the header stays a status line rather than a row of
    // competing buttons.
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
      {showActions ? <RoutineValidationStatusIcon state={validationStatus} /> : null}
      {showActions ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground" aria-label="More routine actions">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            {onOpenMap ? (
              <>
                <DropdownMenuItem onSelect={onOpenMap}>
                  <Waypoints className="mr-2 h-4 w-4" />
                  Map
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            ) : null}
            <DropdownMenuItem disabled={isSaving || isDrafting} onSelect={onOpenDraftAssist}>
              <WandSparkles className="mr-2 h-4 w-4" />
              Draft with AI
            </DropdownMenuItem>
            {isPersisted ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={isSaving}
                  onSelect={onDelete}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete routine
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {isPersisted ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onTest}
          disabled={isSaving || !canTest}
          title={canTest ? 'Test this routine in Test Chat as part of the draft.' : 'Enable this routine to test it.'}
        >
          <FlaskConical className="mr-2 h-4 w-4" />
          Test
        </Button>
      ) : null}
      {showActions ? (
        <Button
          type="button"
          size="icon"
          onClick={onToggleEnabled}
          disabled={isToggling}
          aria-pressed={enabled}
          aria-label={enabled ? 'Disable routine' : 'Enable routine'}
          title={enabled ? 'Take this routine out of service' : 'Publish this routine'}
          className={enabled
            ? 'h-8 w-8 rounded-full bg-amber-500 text-white hover:bg-amber-500/90 focus-visible:ring-amber-500/50'
            : 'h-8 w-8 rounded-full bg-emerald-500 text-white hover:bg-emerald-500/90 focus-visible:ring-emerald-500/50'}
        >
          {enabled ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8 text-muted-foreground"
        onClick={onBack}
        aria-label="Back to routines"
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  )
}
