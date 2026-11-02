import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { useHealth } from '@/api/queries'
import { useActiveProjectId } from '@/lib/project-router'
import { useWebhookList, webhookKey } from '@/hooks/use-webhooks'
import { telegramKey } from '@/hooks/use-telegram'
import { TelegramInboundPanel } from './telegram-inbound'
import { TelegramWizard } from './telegram-wizard'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { TesterArmyE2eCard } from './tester-army-e2e-card'

/**
 * Settings → project → External integrations: third-party tools cezar can install and wire into
 * this project for you. One tab per kind of tool; each tool is a card that owns its own setup
 * (spec 2026-10-10-e2e-one-click-setup).
 */
export function IntegrationsSection() {
  const projectId = useActiveProjectId() ?? 'default'
  const health = useHealth()
  const enabled = health.data?.capabilities.webhooks === true
  const list = useWebhookList(projectId, enabled)
  const client = useQueryClient()
  const [wizardOpen, setWizardOpen] = useState(false)
  const telegramReceivers = list.data?.receivers.filter(row => row.format === 'telegram.v1') ?? []
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4 md:p-6" data-slot="integrations-settings">
      <p className="text-sm text-muted-foreground">
        Tools cezar can set up in this project for you — each one as a task you review and merge.
      </p>
      <section className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4" data-slot="telegram-integration">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">Telegram</h2>
            <p className="mt-1 text-sm text-muted-foreground">Connect one Telegram bot to send task notifications and optionally manage tasks from Telegram.</p>
          </div>
          <Button variant="outline" disabled={!enabled || list.isPending} onClick={() => setWizardOpen(true)}>{telegramReceivers.length ? 'Connect another chat' : 'Connect Telegram'}</Button>
        </div>
        {health.isError && <p role="status" className="text-sm text-danger">Telegram settings are unavailable because server health could not be loaded.</p>}
        {!health.isError && health.data && !enabled && <p className="text-sm text-muted-foreground">Telegram needs webhooks. Start cezar with <code>CEZ_WEBHOOKS=1</code>, then reload this page.</p>}
        {list.error && <p role="alert" className="text-sm text-danger">Telegram settings could not be loaded. Refresh the page and try again.</p>}
        {enabled && !list.isPending && !list.error && <TelegramInboundPanel key={projectId} projectId={projectId} receivers={telegramReceivers} />}
        <TelegramWizard projectId={projectId} open={wizardOpen} onOpenChange={setWizardOpen} onComplete={() => { void client.invalidateQueries({ queryKey: webhookKey(projectId) }); void client.invalidateQueries({ queryKey: telegramKey(projectId) }) }} />
      </section>
      <Tabs defaultValue="test-frameworks">
        <TabsList variant="line" data-slot="integrations-tabs">
          <TabsTrigger value="test-frameworks">Test frameworks</TabsTrigger>
        </TabsList>
        <TabsContent value="test-frameworks" className="pt-4">
          <TesterArmyE2eCard />
        </TabsContent>
      </Tabs>
    </div>
  )
}
