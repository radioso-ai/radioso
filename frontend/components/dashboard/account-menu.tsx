'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import { Check, Gauge, LogOut, Monitor, Moon, Sun, Users } from 'lucide-react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useTheme, type Theme } from '@/components/theme-provider'
import { useAuth } from '@/lib/auth-context'
import { useWorkspace } from '@/lib/workspace-context'
import { buildDashboardHref, type AccountTab, type DashboardRouteState } from '@/lib/dashboard-routes'
import { cn } from '@/lib/utils'

const THEME_OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
]

/**
 * Account/user menu rendered as a floating popup off the sidebar profile card.
 * The card (passed as `children`) is the trigger; Radix owns open/close, keyboard
 * nav, and click-away dismissal, so selecting an item closes the menu.
 */
export function AccountMenu({
  accountId,
  routeState,
  children,
}: {
  accountId: string
  routeState: DashboardRouteState
  children: ReactNode
}) {
  const { activeWorkspace, activeWorkspaceId } = useWorkspace()
  const { theme, setTheme } = useTheme()
  const { logout } = useAuth()

  const activeTab = routeState.section === 'account' ? (routeState.accountTab ?? 'members') : undefined
  const href = (accountTab: AccountTab) =>
    buildDashboardHref(accountId, {
      section: 'account',
      accountTab,
      workspaceId: activeWorkspaceId ?? undefined,
      workspacePublicRouteKey: activeWorkspace?.publicRouteKey,
    })

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuItem asChild>
            <Link href={href('members')} aria-current={activeTab === 'members' ? 'page' : undefined}>
              <Users />
              Members
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href={href('usage')} aria-current={activeTab === 'usage' ? 'page' : undefined}>
              <Gauge />
              Usage
            </Link>
          </DropdownMenuItem>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Appearance
        </DropdownMenuLabel>
        {THEME_OPTIONS.map((option) => (
          <DropdownMenuItem key={option.value} onSelect={() => setTheme(option.value)}>
            <option.icon />
            {option.label}
            <Check className={cn('ml-auto size-4', theme === option.value ? 'opacity-100' : 'opacity-0')} />
          </DropdownMenuItem>
        ))}

        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => void logout()}>
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
