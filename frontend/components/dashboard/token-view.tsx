'use client'

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { workspaceApi } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { Copy, Check, Key } from 'lucide-react'

export function TokenView() {
  const { activeWorkspaceId, activeWorkspace } = useWorkspace()
  const [token, setToken] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!activeWorkspaceId) return

    setIsLoading(true)
    const loadToken = async () => {
      try {
        const fetchedToken = await workspaceApi.getWorkspaceToken(activeWorkspaceId)
        setToken(fetchedToken)
      } catch (error) {
        console.error('Failed to load token:', error)
      } finally {
        setIsLoading(false)
      }
    }
    loadToken()
  }, [activeWorkspaceId])

  const handleCopy = async () => {
    if (!token) return
    await navigator.clipboard.writeText(token)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner className="w-6 h-6" />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-6 py-4">
        <h1 className="text-lg font-medium text-foreground">API Token</h1>
        <p className="text-sm text-muted-foreground">
          API key for <span className="font-medium">{activeWorkspace?.name ?? 'this workspace'}</span>
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-xl">
          <div className="p-4 bg-card border border-border rounded-lg">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                <Key className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h3 className="font-medium text-foreground">API Key</h3>
                <p className="text-sm text-muted-foreground">Use this key to authenticate API requests</p>
              </div>
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="token" className="sr-only">API Token</Label>
              <div className="flex gap-2">
                <Input
                  id="token"
                  value={token || ''}
                  readOnly
                  className="font-mono text-sm"
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleCopy}
                  disabled={!token}
                >
                  {copied ? (
                    <Check className="w-4 h-4 text-green-500" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                  <span className="sr-only">Copy token</span>
                </Button>
              </div>
            </div>
          </div>

          <div className="mt-6 p-4 bg-muted/50 rounded-lg">
            <h4 className="font-medium text-foreground mb-2">Usage</h4>
            <p className="text-sm text-muted-foreground mb-3">
              Include this token in the Authorization header of your API requests:
            </p>
            <code className="block p-3 bg-card border border-border rounded text-sm font-mono text-foreground overflow-x-auto">
              Authorization: Bearer {token?.slice(0, 15)}...
            </code>
          </div>
        </div>
      </div>
    </div>
  )
}
