'use client'

import type { ReactNode } from 'react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

type SkillPickerGroup = {
  key: string
  label?: string
  skills: Array<{ skillName: string; displayName: string }>
}

export function SkillPickerMenu({
  groups,
  emptyMessage,
  isLoading = false,
  error = null,
  createAction = null,
  onSelect,
  children,
}: {
  groups: SkillPickerGroup[]
  emptyMessage: string
  isLoading?: boolean
  error?: string | null
  // Offered by a surface that can author a skill, so an empty catalog is a starting point
  // rather than a dead end. The menu only renders it; the host owns the form.
  createAction?: { label: string; onSelect: () => void } | null
  onSelect: (skillName: string) => void
  children: ReactNode
}) {
  const hasSkills = groups.some((group) => group.skills.length > 0)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {isLoading ? (
          <DropdownMenuItem disabled>Loading skills...</DropdownMenuItem>
        ) : error ? (
          <DropdownMenuItem disabled>{error}</DropdownMenuItem>
        ) : !hasSkills ? (
          <DropdownMenuItem disabled>{emptyMessage}</DropdownMenuItem>
        ) : (
          groups.map((group, index) => (
            <DropdownMenuGroup key={group.key}>
              {index > 0 ? <DropdownMenuSeparator /> : null}
              {group.label ? <DropdownMenuLabel>{group.label}</DropdownMenuLabel> : null}
              {group.skills.map((skill) => (
                <DropdownMenuItem key={skill.skillName} onSelect={() => onSelect(skill.skillName)} className="flex-col items-start gap-0.5">
                  <span className="text-sm font-medium">{skill.displayName}</span>
                  <span className="text-xs text-muted-foreground">{skill.skillName}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          ))
        )}
        {createAction && !isLoading && !error ? (
          <>
            {hasSkills ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem onSelect={createAction.onSelect}>{createAction.label}</DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
