import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ChatWizard } from './telegram-wizard'
import { fixtureProvider } from './chat-provider-fixture'

const api = vi.hoisted(() => ({ begin: vi.fn(), status: vi.fn(), activate: vi.fn(), cancel: vi.fn() }))
vi.mock('@/api/client', () => ({ telegramApi: { setup: api }, webhookApi: {}, cez: {}, unwrap: vi.fn() }))
vi.mock('./telegram-inbound', () => ({ defaultSetupApi: api }))
afterEach(cleanup)
beforeEach(() => {
  vi.resetAllMocks()
  api.cancel.mockResolvedValue(undefined)
  api.begin.mockResolvedValue({ setupId: 'setup', receiverId: 'receiver', deepLink: 'https://example.invalid/setup' })
  api.status.mockResolvedValue({ status: 'candidate', inboundRevision: 'revision', candidate: { userId: 'person', label: 'Person', chatType: 'private' } })
})
// Synthetic descriptor only; no second platform transport is implemented.
const provider = {
  ...fixtureProvider, id: 'slack' as const, name: 'Fixture Chat', format: 'slack.v1' as const,
  bot: {
    ...fixtureProvider.bot,
    fields: [{ name: 'token', label: 'Fixture credential', placeholder: 'fixture-', pattern: /^fixture-/, invalid: 'Invalid fixture credential' }],
    credentialHint: 'Fixture credentials', help: { label: 'Fixture console', href: 'https://example.invalid' },
    setupErrorMessages: {
      invalid_token: 'Generate a new credential in the Fixture console.',
      group_ineligible: 'Invite the fixture app to an eligible channel.',
      bot_conflict: 'Release the fixture app from its other workspace.',
    },
    unavailableMessages: { hosted: 'Use the fixture app locally.', unavailable: 'Fixture control is unavailable.' },
  },
}
function open() {
  render(<ChatWizard provider={provider} projectId="p" open onOpenChange={vi.fn()} setupApi={api} />)
}
function start() {
  fireEvent.change(screen.getByLabelText('Fixture credential'), { target: { value: 'fixture-secret' } })
  fireEvent.click(screen.getByRole('checkbox', { name: /bot is dedicated/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
}

it('two credential fields serialize through provider with consent and preserve cost note', async()=>{
 const multi={...provider,bot:{...provider.bot,fields:[{name:'app',label:'App credential',placeholder:'app-',pattern:/^app-/,invalid:'Invalid app'}, {name:'bot',label:'Bot credential',placeholder:'bot-',pattern:/^bot-/,invalid:'Invalid bot'}],begin:vi.fn((c:any,name:string)=>({token:JSON.stringify(c),name,dedicatedBot:true as const}))}}
 render(<ChatWizard provider={multi} projectId="p" open onOpenChange={vi.fn()} setupApi={api}/>);
 fireEvent.change(screen.getByLabelText('App credential'),{target:{value:'app-secret'}});fireEvent.change(screen.getByLabelText('Bot credential'),{target:{value:'bot-secret'}});
 expect(api.begin).not.toHaveBeenCalled();expect(screen.getByRole('button',{name:'Continue'})).toHaveProperty('disabled',true);
 fireEvent.click(screen.getByRole('checkbox',{name:/bot is dedicated/}));fireEvent.click(screen.getByRole('button',{name:'Continue'}));
 await screen.findByText(/Connected as Person/);expect(multi.bot.begin).toHaveBeenCalledWith({app:'app-secret',bot:'bot-secret'},'Fixture Chat notifications');
 fireEvent.click(screen.getByRole('checkbox',{name:/Enable task control for this private chat/}));
 expect(screen.getByText('Answering, starting and continuing tasks runs the agent and may incur provider costs.')).toBeTruthy();expect(document.body.textContent).not.toContain('app-secret');
})
it('provider with mention discovery never instructs a Telegram Start for private approval',async()=>{
 const mention={...provider,bot:{...provider.bot,discoveryHint:'Mention Fixture to discover.',privateHint:'Mention Fixture privately.',groupHint:'Mention Fixture in a channel.'}};
 render(<ChatWizard provider={mention} projectId="p" open onOpenChange={vi.fn()} setupApi={api}/>);start();await screen.findByText(/Connected as Person/);
 expect(screen.getByText('Mention Fixture privately.')).toBeTruthy();expect(document.body.textContent).not.toContain('first person who presses Start');
})
it('mention-based group approval keeps visibility consent, comparison and permissions', async () => {
 api.status.mockResolvedValue({ status: 'candidate', inboundRevision: 'revision', candidate: { userId: 'person', label: 'Person', chatType: 'group', chatId: 'CHANNEL-A' } })
 api.activate.mockResolvedValue({ receiverId: 'receiver', inboundRevision: 'active-revision' })
 open(); start()
 await screen.findByText(provider.bot.approval.groupControl)
 expect(screen.getByRole('button', { name: 'Activate notifications' })).toHaveProperty('disabled', true)
 fireEvent.click(screen.getByRole('checkbox', { name: /all members of this group/ }))
 fireEvent.click(screen.getByRole('button', { name: 'Activate notifications' }))
 fireEvent.click(await screen.findByRole('checkbox', { name: /Enable optional task control/ }))
 api.status.mockResolvedValue({ status: 'candidate', inboundRevision: 'revision2', candidate: { userId: 'person', label: 'Person', chatType: 'private', comparisonCode: 'COMPARE' } })
 fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
 await screen.findByText(provider.bot.approval.controlHint)
 await screen.findByText(provider.bot.approval.comparisonHint)
 expect(document.body.textContent).not.toContain('private Start')
 expect(screen.queryByRole('checkbox', { name: 'Start tasks' })).toBeNull()
 expect(screen.getByRole('button', { name: 'Activate task control' })).toHaveProperty('disabled', true)
 expect(screen.getByText('Answering, starting and continuing tasks runs the agent and may incur provider costs.')).toBeTruthy()
 fireEvent.click(screen.getByRole('checkbox', { name: /I compared the code/ }))
 expect(screen.getByRole('button', { name: 'Activate task control' })).toHaveProperty('disabled', false)
})
