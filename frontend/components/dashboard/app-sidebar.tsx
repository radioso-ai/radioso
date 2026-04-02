'use client'

import Image from 'next/image'
import Link from 'next/link'

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from '@/components/ui/sidebar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useAuth } from '@/lib/auth-context'
import { useTheme } from 'next-themes'
import {
  MessageSquare,
  History,
  Beaker,
  FileText,
  Settings,
  LogOut,
  Moon,
  Sun,
  Monitor,
  ChevronUp,
  User,
} from 'lucide-react'
import {
  buildDashboardHref,
  type DashboardSection,
} from '@/lib/dashboard-routes'
import { WorkspaceSwitcher } from './workspace-switcher'
import { useWorkspace } from '@/lib/workspace-context'

interface AppSidebarProps {
  accountId: string
  currentView: DashboardSection
}

const navItems = [
  { id: 'chat' as const, label: 'Chat', icon: MessageSquare },
  { id: 'documents' as const, label: 'Documents', icon: FileText },
  { id: 'history' as const, label: 'History', icon: History },
  { id: 'evals' as const, label: 'Evals', icon: Beaker },
  { id: 'settings' as const, label: 'Settings', icon: Settings },
]

export function AppSidebar({ accountId, currentView }: AppSidebarProps) {
  const { user, logout } = useAuth()
  const { activeWorkspaceId } = useWorkspace()
  const { theme, setTheme } = useTheme()

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="p-4">
        <div className="flex items-center gap-2">
          <Image
            src="/radioso-logo.png"
            alt="radioso logo"
            width={32}
            height={32}
            className="h-8 w-8 rounded-lg object-cover flex-shrink-0"
          />
          <span className="font-semibold text-foreground group-data-[collapsible=icon]:hidden">
            radioso
          </span>
        </div>
      </SidebarHeader>

      <div className="px-2">
        <WorkspaceSwitcher />
      </div>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton asChild isActive={currentView === item.id} tooltip={item.label}>
                    <Link
                      href={buildDashboardHref(accountId, {
                        section: item.id,
                        workspaceId: activeWorkspaceId ?? undefined,
                      })}
                    >
                      <item.icon className="w-4 h-4" />
                      <span>{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarSeparator />
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton className="w-full">
                  <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
                    <User className="w-3.5 h-3.5 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0 text-left group-data-[collapsible=icon]:hidden">
                    <p className="text-sm font-medium text-foreground truncate">
                      {user?.email?.split('@')[0] || 'User'}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {user?.email || 'user@example.com'}
                    </p>
                  </div>
                  <ChevronUp className="w-4 h-4 text-muted-foreground group-data-[collapsible=icon]:hidden" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <div className="px-2 py-1.5">
                  <p className="text-sm font-medium">{user?.email?.split('@')[0]}</p>
                  <p className="text-xs text-muted-foreground">{user?.email}</p>
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setTheme('light')}>
                  <Sun className="w-4 h-4 mr-2" />
                  Light
                  {theme === 'light' && <span className="ml-auto text-xs">✓</span>}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTheme('dark')}>
                  <Moon className="w-4 h-4 mr-2" />
                  Dark
                  {theme === 'dark' && <span className="ml-auto text-xs">✓</span>}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTheme('system')}>
                  <Monitor className="w-4 h-4 mr-2" />
                  System
                  {theme === 'system' && <span className="ml-auto text-xs">✓</span>}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={logout} className="text-destructive focus:text-destructive">
                  <LogOut className="w-4 h-4 mr-2" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
