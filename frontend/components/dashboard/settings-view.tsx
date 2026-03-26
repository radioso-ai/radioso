'use client'

import { ConnectorsTab } from '@/components/dashboard/connectors/connectors-tab'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { GeneralTab } from '@/components/dashboard/settings/general-tab'
import { IngestionSettingsPanel } from '@/components/dashboard/settings/ingestion-settings-panel'
import { RetrievalSettingsPanel } from '@/components/dashboard/settings/retrieval-settings-panel'

export function SettingsView() {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-6 py-4">
        <h1 className="text-lg font-medium text-foreground">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Configure workspace, ingestion, retrieval, and external chat channel behavior.
        </p>
      </div>

      <Tabs defaultValue="general" className="flex flex-1 flex-col">
        <div className="border-b border-border px-6 py-3">
          <TabsList>
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="ingestion">Ingestion</TabsTrigger>
            <TabsTrigger value="retrieval">Retrieval</TabsTrigger>
            <TabsTrigger value="connectors">Chat Connectors</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="general" className="flex-1 overflow-hidden">
          <GeneralTab />
        </TabsContent>

        <TabsContent value="ingestion" className="flex-1 overflow-hidden">
          <IngestionSettingsPanel />
        </TabsContent>

        <TabsContent value="retrieval" className="flex-1 overflow-hidden">
          <RetrievalSettingsPanel />
        </TabsContent>

        <TabsContent value="connectors" className="flex-1 overflow-y-auto p-6">
          <div className="mb-6 max-w-3xl">
            <h2 className="text-lg font-medium text-foreground">Chat Connectors</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Connect external messaging channels to this workspace. Connector config is
              schema-driven, so new connector types appear here automatically once the backend
              registers them.
            </p>
          </div>
          <ConnectorsTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
