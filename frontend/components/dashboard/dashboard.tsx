'use client'

import { useState } from 'react'
import { SidebarProvider, SidebarInset, SidebarTrigger } from '@/components/ui/sidebar'
import { AppSidebar } from './app-sidebar'
import { ChatView } from './chat-view'
import { DocumentsView } from './documents-view'
import { SettingsView } from './settings-view'
import { TokenView } from './token-view'

type View = 'chat' | 'documents' | 'settings' | 'token'

export function Dashboard() {
  const [currentView, setCurrentView] = useState<View>('chat')

  return (
    <SidebarProvider>
      <AppSidebar currentView={currentView} onViewChange={setCurrentView} />
      <SidebarInset>
        <header className="flex items-center h-12 px-4 border-b border-border md:hidden">
          <SidebarTrigger />
        </header>
        <div className="flex-1 h-[calc(100vh-3rem)] md:h-screen">
          {currentView === 'chat' && <ChatView />}
          {currentView === 'documents' && <DocumentsView />}
          {currentView === 'settings' && <SettingsView />}
          {currentView === 'token' && <TokenView />}
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
