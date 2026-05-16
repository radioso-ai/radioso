declare module '@/components/ui/button' {
  import type { ComponentType, ReactNode } from 'react'

  export const Button: ComponentType<{
    asChild?: boolean
    className?: string
    disabled?: boolean
    onClick?: () => void
    type?: 'button' | 'submit' | 'reset'
    variant?: 'default' | 'outline' | 'ghost' | 'secondary'
    size?: 'default' | 'sm' | 'lg' | 'icon'
    children?: ReactNode
  }>
}

declare module '@/components/ui/avatar' {
  import type { ComponentType, ReactNode } from 'react'

  export const Avatar: ComponentType<{ className?: string; children?: ReactNode }>
  export const AvatarImage: ComponentType<{ alt?: string; className?: string; src?: string }>
  export const AvatarFallback: ComponentType<{ className?: string; children?: ReactNode }>
}

declare module '@/components/ui/collapsible' {
  import type { ComponentType, ReactNode } from 'react'

  export const Collapsible: ComponentType<{
    className?: string
    children?: ReactNode
    open?: boolean
    onOpenChange?: (open: boolean) => void
  }>
  export const CollapsibleTrigger: ComponentType<{
    className?: string
    children?: ReactNode
  }>
  export const CollapsibleContent: ComponentType<{
    className?: string
    children?: ReactNode
  }>
}

declare module '@/components/ui/input' {
  import type { ComponentType } from 'react'

  export const Input: ComponentType<{
    autoFocus?: boolean
    disabled?: boolean
    id?: string
    onChange?: (event: { target: { value: string } }) => void
    onKeyDown?: (event: { key: string; preventDefault?: () => void }) => void
    placeholder?: string
    required?: boolean
    type?: string
    value?: string
    className?: string
  }>
}

declare module '@/components/ui/label' {
  import type { ComponentType, ReactNode } from 'react'

  export const Label: ComponentType<{
    htmlFor?: string
    children?: ReactNode
    className?: string
  }>
}

declare module '@/components/ui/spinner' {
  import type { ComponentType } from 'react'

  export const Spinner: ComponentType<{ className?: string }>
}

declare module '@/components/ui/textarea' {
  import type { ComponentType } from 'react'

  export const Textarea: ComponentType<{
    disabled?: boolean
    id?: string
    onChange?: (event: { target: { value: string } }) => void
    placeholder?: string
    required?: boolean
    value?: string
    className?: string
    rows?: number
  }>
}

declare module '@/lib/api' {
  export function request<T>(path: string, init?: RequestInit & { withApiToken?: boolean }): Promise<T>
}

declare module '@/lib/api-client' {
  export const API_BASE: string
  export function buildError(response: Response): Promise<{
    error: {
      code: string
      message: string
      retryAfterSeconds?: number
    }
  }>
  export function getStoredActiveWorkspaceId(): string | null
  export function request<T>(path: string, init?: RequestInit, options?: { withSession?: boolean; withApiToken?: boolean }): Promise<T>
}

declare module '@/lib/agent-creation-handoff' {
  export const AGENT_CREATION_HANDOFF_STORAGE_KEY: string
}

declare module '@/lib/dashboard-routes' {
  export function buildDashboardHref(accountId: string, input: {
    section: string
    agentId?: string
    agentTab?: string
    anchor?: string
    workspaceId?: string | null
    workspacePublicRouteKey?: string | null
  }): string
}

declare module '@/lib/workspace-context' {
  export function useWorkspace(): {
    activeWorkspace: { publicRouteKey: string } | null
    activeWorkspaceId: string | null
  }
}

declare module 'lucide-react' {
  import type { ComponentType } from 'react'

  export const ArrowRight: ComponentType<{ className?: string }>
  export const Bot: ComponentType<{ className?: string }>
  export const Check: ComponentType<{ className?: string }>
  export const ChevronDown: ComponentType<{ className?: string }>
  export const FileText: ComponentType<{ className?: string }>
  export const Globe: ComponentType<{ className?: string }>
  export const MessageCircle: ComponentType<{ className?: string }>
  export const RefreshCw: ComponentType<{ className?: string }>
  export const Sparkles: ComponentType<{ className?: string }>
  export const X: ComponentType<{ className?: string }>
}

declare module '@/components/ui/card' {
  import type { ComponentType, ReactNode } from 'react'

  export const Card: ComponentType<{ className?: string; children?: ReactNode }>
  export const CardHeader: ComponentType<{ className?: string; children?: ReactNode }>
  export const CardTitle: ComponentType<{ className?: string; children?: ReactNode }>
  export const CardDescription: ComponentType<{ className?: string; children?: ReactNode }>
  export const CardContent: ComponentType<{ className?: string; children?: ReactNode }>
  export const CardFooter: ComponentType<{ className?: string; children?: ReactNode }>
}

declare module '@/components/ui/dialog' {
  import type { ComponentType, ReactNode } from 'react'

  export const Dialog: ComponentType<{
    open?: boolean
    onOpenChange?: (open: boolean) => void
    children?: ReactNode
  }>
  export const DialogContent: ComponentType<{
    className?: string
    children?: ReactNode
  }>
  export const DialogTitle: ComponentType<{
    className?: string
    children?: ReactNode
  }>
  export const DialogDescription: ComponentType<{
    className?: string
    children?: ReactNode
  }>
}
