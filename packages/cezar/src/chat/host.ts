import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { z } from 'zod';
import type { updateWebhookSchema, WebhookOperation, WebhookReceiver } from '@open-mercato/cezar-contract';
import { ChatInbound, withProvider, type ChatProviderAdapter, type ChatServiceDependencies } from './service.ts';
import { ChatReceiverCommittedFailure } from './setup.ts';
import { setAdapterNotifications } from './adapter-notifications.ts';
import { decodeChatCredentials } from './credentials.ts';
import { ensureChatTransport, chatProvider, chatTransport, chatTransportAvailable, projectChatExtensions, watchChatExtensions, watchChatAdapterSelection } from './registry.ts';
import { ChatTransportError, type ChatProviderId, type ChatTransport } from './provider.ts';
import type { ChatConnection } from './connection.ts';
import { ChatSendBudget } from './send-budget.ts';
import type { ConversationDependencies } from './conversation.ts';
import { telegramAdapter } from './providers/telegram/adapter.ts';
import { telegramClient, TelegramApiError, type TelegramCall } from './providers/telegram/client.ts';
import { slackAdapter } from './providers/slack/adapter.ts';
import { SlackTokenRotation, slackRotationStorage } from './providers/slack/rotation.ts';
import { createSlackWire, type SlackWire } from './providers/slack/client.ts';
import { slackTransport } from './providers/slack/transport.ts';
import { discordAdapter } from './providers/discord/adapter.ts';
import { discordTransport, type DiscordTransportOptions } from './providers/discord/index.ts';
import { WebhookStateError, type EndpointRegistry, type PrivateReceiver } from '../webhooks/endpoints.ts';
import { telegramToken } from '../webhooks/telegram-secrets.ts';
import { renderChatNotification } from '../webhooks/renderer.ts';
import { renderTelegramMessage } from '../webhooks/telegram.ts';
import { sendChatNotification, chatSendFailure, type SendResult, type WebhookSend } from '../webhooks/transport.ts';
import type { WebhookSource } from '../webhooks/source.ts';
import type { RunRecord } from '../runs/store.ts';

export type ChatInteractions = Pick<ConversationDependencies, 'context' | 'deliver' | 'createTask' | 'prepareControl'>;
type Receipt = Parameters<ChatInbound['recordDelivery']>[3];

/** Provider-specific seams; the shipped defaults build every transport from the project's vault. */
export interface ChatHostSeams {
  discordOptions?: (resolve: () => Promise<string>) => DiscordTransportOptions;
  slackWire?: (resolve: () => Promise<string>) => SlackWire;
  chatTransport?: (provider: 'slack' | 'discord', credential: string) => ChatTransport;
  telegramCall?: (receiverId: string) => TelegramCall;
}
export interface ChatHostOptions extends ChatHostSeams {
  /** Default public artifacts must never fall back to private transports. */
  publicRuntime?: boolean;
  projectId(): string; root: string; installationId: string;
  /** The project's webhook state directory; each provider keeps `chat/<provider>` inside it. */
  directory: string; mode: 'local' | 'hosted'; dryRun?: boolean; now?: () => number; serverPorts(): readonly number[];
}
/** What the chat host needs from the webhook service that owns receivers and their delivery queue. */
export interface ChatHostWebhooks {
  endpoints: Pick<EndpointRegistry, 'live' | 'privateReceiver' | 'chatCredential' | 'destinationUrl'>;
  assertUsable(): void; stopped(): boolean; episode(runId: string): string | undefined; emit(event: string): void;
  /** Serialized attach that also cancels the receiver's unsent deliveries. */
  attachChat(input: Parameters<EndpointRegistry['attachChat']>[0]): Promise<PrivateReceiver>;
  create(input: unknown): Promise<{ receiver: WebhookReceiver }>;
  update(id: string, input: z.input<typeof updateWebhookSchema>): Promise<WebhookReceiver>;
  resume(id: string, revision: number): Promise<unknown>;
  pause(id: string, revision: number): Promise<WebhookReceiver>;
  activate(id: string, revision: number): Promise<unknown>;
  delete(id: string, revision: number): Promise<void>;
  test(id: string, input: WebhookOperation): Promise<{ deliveryId: string }>;
  settleTest(deliveryId: string): Promise<void>;
}
/** The narrow surface the webhook delivery loop uses for chat receivers. */
export interface ChatDelivery {
  sendBudget(receiver: PrivateReceiver): ChatSendBudget | undefined;
  /** The receiver a chat-started task's source chat is delivered through, while chat owns it. */
  sourceReceiver(run: RunRecord | undefined): string | undefined;
  /** Wire body for a chat receiver, or undefined for a plain webhook format. */
  render(receiver: PrivateReceiver, delivery: { format?: string; receiverName?: string }, body: string): string | undefined;
  /** Sends a bot-attached receiver; undefined means a plain URL send. */
  send(receiver: PrivateReceiver, request: WebhookSend): Promise<SendResult> | undefined;
  recordDelivery(receiver: PrivateReceiver, source: WebhookSource, deliveryRevision: number, receipt: Receipt): Promise<void>;
}

const providerOf = (format: string): ChatProviderId | undefined => format === 'cezar.json.v1' || format === 'telegram.v1' ? undefined : format.replace(/\.v1$/, '');

/** Owns every chat provider of one project: composition, public transport selection and lifecycle. */
export class ChatHost implements ChatDelivery {
  readonly chats = new Map<ChatProviderId, ChatInbound>();
  readonly telegram: ChatInbound;
  readonly slack: ChatInbound;
  readonly discord: ChatInbound;
  private interactions?: ChatInteractions;
  private readonly publicProviders = new Set<ChatProviderId>();
  private unwatchExtensions?: () => void;
  private unwatchSelection?: () => void;
  private extensionChanges: Promise<void> = Promise.resolve();
  private readonly slackRotation: SlackTokenRotation;
  private readonly botBudgets = new Map<string, ChatSendBudget>();
  private startQueued = false;
  private disposed = false;

  constructor(private readonly options: ChatHostOptions, private readonly webhooks: ChatHostWebhooks) {
    this.slackRotation = new SlackTokenRotation(slackRotationStorage({ kind: 'project', projectId: options.projectId(), root: options.root }));
    const telegram = this.dependencies('telegram', {
      call: options.telegramCall ?? ((receiverId: string) => this.telegramCall(async () => this.telegramToken(receiverId))),
      callToken: (token: string) => this.telegramCall(async () => token),
      createReceiverFromToken: (token: string, name: string | undefined, chatId: string, existingId?: string) => this.telegramReceiver(token, name, chatId, existingId),
      removeBotReceivers: (botId: string, receiverIds: readonly string[]) => this.removeTelegramReceivers(botId, receiverIds),
    });
    this.telegram = this.add('telegram', withProvider(telegram, this.nativeAdapter('telegram', telegramAdapter(telegram))));
    const slack = this.dependencies('slack', {
      wire: (id: string) => this.slackWire(() => this.liveCredential('slack', id)),
      wireCredential: (credential: string) => this.slackWire(async () => credential),
    });
    this.slack = this.add('slack', withProvider(slack, this.nativeAdapter('slack', slackAdapter(slack))));
    const discord = this.dependencies('discord', {
      discord: (id: string) => this.discordOptions(() => this.liveCredential('discord', id)),
      discordCredential: (credential: string) => this.discordOptions(async () => credential),
    });
    this.discord = this.add('discord', withProvider(discord, this.nativeAdapter('discord', discordAdapter(discord))));
    this.unwatchSelection = watchChatAdapterSelection(options.root, async (id, enabled) => {
      const inbound = this.chats.get(id);
      if (!inbound || this.disposed) throw Error('Chat host unavailable');
      await inbound.setAdapterEnabled(enabled);
      await setAdapterNotifications(options.directory, id, enabled, {
        live: () => webhooks.endpoints.live(), assertUsable: () => webhooks.assertUsable(),
        pause: (id, revision) => webhooks.pause(id, revision), resume: (id, revision) => webhooks.resume(id, revision),
      });
    });
    this.unwatchExtensions = watchChatExtensions(options.root, id => this.refreshExtensionChat(id));
  }
  private add(id: ChatProviderId, deps: ChatServiceDependencies): ChatInbound {
    const inbound = new ChatInbound(deps); this.chats.set(id, inbound); return inbound;
  }
  setInteractions(interactions: ChatInteractions): void { this.interactions = interactions; }
  async load(): Promise<void> { for (const chat of this.chats.values()) await chat.load().catch(() => undefined); }
  /** Explicit lifecycle start; passive reads and outbound delivery never invoke this. */
  async start(): Promise<void> {
    if (this.disposed || this.options.mode !== 'local') return;
    for (const provider of projectChatExtensions(this.options.root)) if (!this.chats.has(provider.id)) await this.refreshExtensionChat(provider.id);
    for (const [id, chat] of this.chats) {
      // Activation publishes a transport and may start this service. Do it before
      // entering startBot, so publication never waits on its own pending start.
      if (chat.needsTransport() && this.publicSelected(id)) await ensureChatTransport(this.options.root, id);
      if (!this.publicSelected(id) || chatTransportAvailable(this.options.root, id)) await chat.start();
    }
  }
  queueStart(): void {
    if (this.startQueued) return;
    this.startQueued = true;
    queueMicrotask(() => { this.startQueued = false; void this.start().catch(() => undefined); });
  }
  /** Stops watching first so no extension provider is registered after disposal. */
  async dispose(): Promise<void> {
    this.unwatchSelection?.(); this.unwatchSelection = undefined;
    this.unwatchExtensions?.(); this.unwatchExtensions = undefined;
    await this.extensionChanges;
    if (this.disposed) return;
    this.disposed = true;
    for (const chat of this.chats.values()) await chat.dispose();
  }
  async waitForExtensions(): Promise<void> { this.unwatchExtensions?.(); this.unwatchExtensions = undefined; await this.extensionChanges; }

  // ---- ChatDelivery -------------------------------------------------------
  private inbound(receiver: PrivateReceiver): ChatInbound | undefined { return this.chats.get(receiver.format.replace('.v1', '') as ChatProviderId); }
  sendBudget(receiver: PrivateReceiver): ChatSendBudget | undefined {
    if (receiver.format === 'telegram.v1') return this.telegram.sendBudget(receiver);
    if (!receiver.chatSecret || !receiver.chatBotId) return;
    const provider = providerOf(receiver.format);
    if (!provider || !chatProvider(provider, this.options.root)) return;
    const budget = this.budgetForBot(provider, receiver.chatBotId); budget.share(receiver.chatSecret.sha256); return budget;
  }
  sourceReceiver(run: RunRecord | undefined): string | undefined {
    return run?.chatSource && this.chats.get(run.chatSource.provider)?.ownsSourceDelivery(run) ? run.chatSource.receiverId : undefined;
  }
  render(receiver: PrivateReceiver, delivery: { format?: string; receiverName?: string }, body: string): string | undefined {
    const provider = providerOf(receiver.format);
    if (provider && receiver.chatSecret && receiver.chatId) {
      return renderChatNotification(body, chatProvider(provider, this.options.root)!.presentation, receiver.chatId, delivery.receiverName ?? receiver.name, this.inbound(receiver)?.repliesActive(receiver) === true);
    }
    // The deliveryRevision fence ties this chat ID to the configuration the delivery was admitted for.
    if (delivery.format === 'telegram.v1') return renderTelegramMessage(body, { chatId: receiver.chatId ?? '', receiverName: delivery.receiverName, replyHint: this.telegram.repliesActive(receiver) });
    return undefined;
  }
  send(receiver: PrivateReceiver, request: WebhookSend): Promise<SendResult> | undefined {
    if(this.options.mode!=='local' && (receiver.format==='telegram.v1'||receiver.chatBotId))return Promise.resolve({kind:'policy',reason:'chat_unavailable'});
    if (receiver.format === 'telegram.v1' && this.publicSelected('telegram')) return this.sendPublicTelegram(receiver, request);
    if (receiver.format === 'telegram.v1' || (!receiver.chatSecret && !receiver.chatId && !receiver.chatBotId)) return undefined;
    return this.sendBot(receiver, request);
  }
  private async sendPublicTelegram(receiver: PrivateReceiver, request: WebhookSend): Promise<SendResult> {
    if (request.policy.mode !== 'local' || !receiver.chatId) return { kind: 'policy', reason: 'chat_unavailable' };
    const valid = () => !this.webhooks.stopped() && !request.signal?.aborted && this.webhooks.endpoints.privateReceiver(receiver.id)?.deliveryRevision === receiver.deliveryRevision;
    try {
      const body = JSON.parse(request.body) as { text?: unknown; chat_id?: unknown };
      if (typeof body.text !== 'string' || String(body.chat_id) !== receiver.chatId) return { kind: 'policy', reason: 'chat_unavailable' };
      const token = await this.telegramToken(receiver.id), botId = token.split(':')[0]!;
      const transport = this.credentialTransport('telegram', token, { id: botId, revision: receiver.chatSecret?.sha256 ?? String(receiver.deliveryRevision) }).guarded(valid);
      if ((await transport.identify(request.signal)).id !== botId || !valid()) return { kind: 'http', status: 410 };
      return sendChatNotification(transport, receiver.chatId, body.text, request.signal, valid);
    } catch (error) { return chatSendFailure(error); }
  }
  private async sendBot(receiver: PrivateReceiver, request: WebhookSend): Promise<SendResult> {
    if (!receiver.chatSecret) return { kind: 'policy', reason: 'credentials_unavailable' };
    // A bot attachment can never degrade into an incoming-webhook request.
    const provider = providerOf(receiver.format);
    if (!provider || !receiver.chatId || !receiver.chatBotId || request.policy.mode !== 'local') return { kind: 'policy', reason: 'chat_unavailable' };
    const valid = () => !this.webhooks.stopped() && !request.signal?.aborted && this.webhooks.endpoints.privateReceiver(receiver.id)?.deliveryRevision === receiver.deliveryRevision;
    try {
      const credential = await this.webhooks.endpoints.chatCredential(receiver);
      const transport = this.credentialTransport(provider, credential, {id:receiver.chatBotId,revision:receiver.chatSecret.sha256}).guarded(valid);
      const identity = await transport.identify(request.signal);
      if (!valid() || identity.id !== receiver.chatBotId) return { kind: 'http', status: 410 };
      return sendChatNotification(transport, receiver.chatId, request.body, request.signal, valid);
    } catch (error) {
      if (error instanceof WebhookStateError) return error.status === 503 ? { kind: 'transient', reason: 'credentials_unavailable' } : { kind: 'http', status: 410 };
      return chatSendFailure(error);
    }
  }
  async recordDelivery(receiver: PrivateReceiver, source: WebhookSource, deliveryRevision: number, receipt: Receipt): Promise<void> {
    await this.inbound(receiver)?.recordDelivery(source, receiver.id, deliveryRevision, receipt).catch(() => undefined);
  }

  // ---- composition --------------------------------------------------------
  private budgetForBot(provider: ChatProviderId, botId: string): ChatSendBudget {
    const key = `${provider}:${botId}`;
    let budget = this.botBudgets.get(key);
    if (!budget) { budget = new ChatSendBudget(this.options.now ?? Date.now, chatProvider(provider, this.options.root)!.limits); this.botBudgets.set(key, budget); }
    return budget;
  }
  /** One dependency object per provider; `extra` holds the provider's own receiver strategy and seams. */
  private dependencies<E extends object>(provider: ChatProviderId, extra: E): Omit<ChatServiceDependencies, 'provider' | 'transport' | 'credentialTransport'> & E {
    const host = this, webhooks = this.webhooks, options = this.options;
    const interactions = () => { webhooks.assertUsable(); if (!host.interactions) throw new Error('Chat context unavailable'); return host.interactions; };
    // Telegram uses the same bundled owner as the other built-in providers.
    return {
      get projectId() { return options.projectId(); }, root: options.root, installationId: options.installationId,
      directory: join(options.directory, 'chat', provider), mode: options.mode, dryRun: options.dryRun, now: options.now,
      receivers: () => webhooks.endpoints.live(),
      changed: () => { webhooks.emit(`${provider}-change`); if (provider.includes('/')) webhooks.emit('extension-chat-change'); },
      ...(provider !== 'telegram' ? { budgetForBot: (id: string) => this.budgetForBot(provider, id) } : {}),
      context: () => interactions().context(),
      deliver: (...args) => interactions().deliver(...args),
      createTask: (...args) => { const value = interactions(); if (!value.createTask) throw new Error('Chat context unavailable'); return value.createTask(...args); },
      prepareControl: (...args) => { webhooks.assertUsable(); return host.interactions?.prepareControl?.(...args) ?? Promise.resolve(undefined); },
      episode: id => webhooks.episode(id),
      createReceiverFromToken: (credential, name, chatId, existingId, expectedRevision) => this.chatReceiver(provider, credential, name, chatId, existingId, expectedRevision),
      removeSetupReceiver: async id => { const receiver = webhooks.endpoints.privateReceiver(id); if (receiver) await webhooks.delete(id, receiver.revision); },
      removeBotReceivers: async (botId, ids) => {
        for (const receiver of webhooks.endpoints.live()) if (receiver.format === `${provider}.v1` && (receiver.chatBotId === botId || ids.includes(receiver.id))) await webhooks.delete(receiver.id, receiver.revision);
      },
      ...extra,
    } satisfies Omit<ChatServiceDependencies, 'provider' | 'transport' | 'credentialTransport'>;
  }
  private publicSelected(id: ChatProviderId): boolean {
    if(this.options.publicRuntime && (id==='telegram'||id==='slack'||id==='discord'))return true;
    if (projectChatExtensions(this.options.root).some(provider => provider.id === id)) this.publicProviders.add(id);
    return this.publicProviders.has(id);
  }
  private nativeAdapter(id: 'telegram' | 'slack' | 'discord', compatibility: ChatProviderAdapter): ChatProviderAdapter {
    return { provider: compatibility.provider,
      transport: receiverId => !this.publicSelected(id) ? compatibility.transport(receiverId) : lazyChatTransport(async () => {
        const receiver = this.webhooks.endpoints.privateReceiver(receiverId);
        if (!receiver) throw new ChatTransportError({ kind: 'auth' });
        const credential = id === 'telegram' ? await this.telegramToken(receiverId) : await this.liveCredential(id, receiverId);
        return this.credentialTransport(id, credential, { id: receiver.chatBotId ?? credential.split(':')[0]!, revision: receiver.chatSecret?.sha256 ?? String(receiver.deliveryRevision) });
      }, () => !this.webhooks.stopped()),
      credentialTransport: credential => this.publicSelected(id) ? this.credentialTransport(id, credential) : compatibility.credentialTransport!(credential),
    };
  }
  private refreshExtensionChat(id: ChatProviderId): Promise<void> {
    const operation = this.extensionChanges.then(async () => {
      if (id === 'telegram' || id === 'slack' || id === 'discord') {
        const declared = projectChatExtensions(this.options.root).some(provider => provider.id === id);
        if (declared) this.publicProviders.add(id);
        const available = chatTransportAvailable(this.options.root, id);
        if (!this.disposed) await this.chats.get(id)?.replaceTransport(available);
        return;
      }
      await this.chats.get(id)?.dispose(); this.chats.delete(id);
      if (this.disposed || this.webhooks.stopped()) return;
      const provider = chatProvider(id, this.options.root);
      if (!provider) return;
      const adapter: ChatProviderAdapter = { provider,
        transport: receiverId => {
          // Credential resolution remains host-owned and is checked for every receiver generation.
          const receiver = this.webhooks.endpoints.privateReceiver(receiverId);
          if (!receiver) throw new ChatTransportError({ kind: 'auth' });
          const resolve = async () => this.credentialTransport(id, await this.liveCredential(id, receiverId), {id:receiver.chatBotId ?? receiver.id,revision:receiver.chatSecret?.sha256 ?? String(receiver.deliveryRevision)});
          const guard = () => !this.webhooks.stopped() && this.webhooks.endpoints.privateReceiver(receiverId)?.deliveryRevision === receiver.deliveryRevision;
          return lazyChatTransport(resolve, guard);
        },
        credentialTransport: credential => this.credentialTransport(id, credential),
      };
      const inbound = this.add(id, withProvider(this.dependencies(id, {}), adapter));
      await inbound.load(); await inbound.start();
    });
    this.extensionChanges = operation.catch(() => undefined);
    return operation;
  }
  // ---- receivers ----------------------------------------------------------
  /** Bot-attached receivers (every provider but Telegram): attach, test, activate, owned revisions only. */
  private async chatReceiver(provider: ChatProviderId, credential: string, name: string | undefined, chatId: string, existingId?: string, expectedRevision?: number): Promise<PrivateReceiver> {
    const webhooks = this.webhooks;
    webhooks.assertUsable();
    if (this.options.mode !== 'local') throw new WebhookStateError(409, 'Chat is local only');
    const descriptor = chatProvider(provider, this.options.root)!;
    const transport = this.credentialTransport(provider, credential);
    const identity = await transport.identify();
    const inspected = await transport.inspect(chatId);
    if (inspected.id !== chatId || !inspected.eligible || (inspected.kind === 'group') !== descriptor.presentation.isGroup(chatId)) throw new WebhookStateError(409, 'Invalid chat destination');
    const receiver = await webhooks.attachChat({ receiverId: existingId, expectedRevision, name, format: descriptor.format,
      url: descriptor.destination(credential), chatId, botId: identity.id, credential });
    const operationId = randomUUID();
    // Attachment and test admission are the only revisions this attempt owns.
    // A rename also invalidates setup consent, even when it keeps deliveryRevision.
    const owned = (row: PrivateReceiver | undefined): row is PrivateReceiver => !!row
      && row.state === 'inactive' && row.deliveryRevision === receiver.deliveryRevision
      && (row.revision === receiver.revision
        || (row.revision === receiver.revision + 1 && row.lastOperation === operationId));
    try {
      const { deliveryId } = await webhooks.test(receiver.id, { expectedRevision: receiver.revision, deliveryRevision: receiver.deliveryRevision, operationId });
      await webhooks.settleTest(deliveryId);
      const tested = webhooks.endpoints.privateReceiver(receiver.id);
      if (!owned(tested) || tested.revision !== receiver.revision + 1 || tested.lastTest !== 'success') throw new WebhookStateError(409, 'Chat receiver test failed');
      await webhooks.activate(tested.id, tested.revision);
      const active = webhooks.endpoints.privateReceiver(receiver.id);
      if (!active || active.revision !== tested.revision + 1 || active.deliveryRevision !== tested.deliveryRevision || active.state !== 'active') throw new WebhookStateError(409, 'Chat receiver changed');
      return active;
    } catch (error) {
      const left = webhooks.endpoints.privateReceiver(receiver.id);
      if (owned(left)) {
        if (!existingId) await webhooks.delete(left.id, left.revision).catch(() => undefined);
        else throw new ChatReceiverCommittedFailure(left, error);
      }
      throw error;
    }
  }
  /**
   * Telegram keeps its token in the receiver URL (telegram.v1 rows carry no chatBotId), so its
   * setup reuses the webhook create/update path: `existingId` is reused, never duplicated, and a
   * receiver made here is deleted, vault entry included, when its test does not succeed.
   */
  private async telegramReceiver(token: string, name: string | undefined, chatId: string, existingId?: string): Promise<PrivateReceiver> {
    const webhooks = this.webhooks;
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    let receiver = existingId ? webhooks.endpoints.privateReceiver(existingId) : undefined;
    if (receiver && (receiver.format !== 'telegram.v1' || receiver.chatId !== chatId)) receiver = undefined;
    const created = !receiver;
    if (!receiver) {
      const made = await webhooks.create({ name: name ?? 'Telegram', format: 'telegram.v1', url, chatId: chatId,
        profile: 'standard', preset: 'attention', events: ['task.attention_required'], graceSeconds: 0 });
      receiver = webhooks.endpoints.privateReceiver(made.receiver.id)!;
    } else if (receiver.chatSecret?.sha256 !== createHash('sha256').update(token).digest('hex')) {
      // A new token for the same bot and chat replaces the stored one; the change needs a fresh test.
      await webhooks.update(receiver.id, { ...storedSettings(receiver), expectedRevision: receiver.revision, url });
      receiver = webhooks.endpoints.privateReceiver(receiver.id)!;
    }
    try {
      if (receiver.state === 'paused' && receiver.lastTest === 'success') await webhooks.resume(receiver.id, receiver.revision);
      else if (receiver.state === 'inactive' || receiver.state === 'disabled' || receiver.lastTest !== 'success') {
        if (receiver.state === 'paused') throw new WebhookStateError(409, 'Telegram receiver is paused');
        const { deliveryId } = await webhooks.test(receiver.id, { expectedRevision: receiver.revision, deliveryRevision: receiver.deliveryRevision, operationId: randomUUID() });
        await webhooks.settleTest(deliveryId);
        const tested = webhooks.endpoints.privateReceiver(receiver.id);
        if (!tested || tested.lastTest !== 'success') throw new WebhookStateError(409, 'Telegram receiver test failed');
        if (tested.state !== 'active' && tested.state !== 'suspended') await webhooks.activate(tested.id, tested.revision);
      }
      const active = webhooks.endpoints.privateReceiver(receiver.id);
      if (!active) throw new WebhookStateError(404, 'Telegram receiver disappeared');
      return active;
    } catch (error) {
      const left = created ? webhooks.endpoints.privateReceiver(receiver.id) : undefined;
      if (left) await webhooks.delete(left.id, left.revision).catch(() => undefined);
      throw error;
    }
  }
  /** Disconnecting a bot deletes every receiver that sends through it (spec 2026-10-29 §Disconnect). */
  private async removeTelegramReceivers(botId: string, receiverIds: readonly string[]): Promise<void> {
    const ids = new Set(receiverIds);
    for (const receiver of this.webhooks.endpoints.live()) {
      if (receiver.format !== 'telegram.v1') continue;
      if (ids.has(receiver.id) || telegramToken(receiver.url)?.startsWith(`${botId}:`)) await this.webhooks.delete(receiver.id, receiver.revision);
    }
  }

  // ---- credentials and transports -----------------------------------------
  private telegramCall(token: () => Promise<string>): TelegramCall {
    const options = this.options;
    return telegramClient({ dryRun: options.dryRun, policy: { mode: options.mode, allowLocalNetwork: false, serverPorts: options.serverPorts() }, token });
  }
  private async telegramToken(receiverId: string): Promise<string> {
    const { endpoints } = this.webhooks;
    this.webhooks.assertUsable();
    const receiver = endpoints.privateReceiver(receiverId), fingerprint = receiver?.chatSecret?.sha256;
    if (!receiver || receiver.format !== 'telegram.v1' || !fingerprint) throw new TelegramApiError('http', 401);
    try {
      const url = await endpoints.destinationUrl(receiver);
      if (endpoints.privateReceiver(receiverId)?.chatSecret?.sha256 !== fingerprint) throw new Error('changed');
      const token = telegramToken(url);
      if (!token) throw new Error('missing');
      return token;
    } catch (error) {
      // A locked keychain is not a revoked token: let the poller back off.
      if (error instanceof WebhookStateError && error.status === 503) throw new TelegramApiError('network');
      throw new TelegramApiError('http', 401);
    }
  }
  private discordOptions(resolve: () => Promise<string>): DiscordTransportOptions {
    if (this.options.discordOptions) return this.options.discordOptions(resolve);
    return { dryRun: this.options.dryRun, token: async () => {
      this.webhooks.assertUsable();
      if (this.options.mode !== 'local') throw new ChatTransportError({ kind: 'blocked' });
      return resolve();
    } };
  }
  private slackWire(resolve: () => Promise<string>): SlackWire {
    if (this.options.slackWire) return this.options.slackWire(resolve);
    return createSlackWire(async () => {
      this.webhooks.assertUsable();
      if (this.options.mode !== 'local' || this.options.dryRun) throw new ChatTransportError({ kind: 'blocked' });
      return resolve();
    }, { rotation: this.slackRotation });
  }
  private async liveCredential(provider: ChatProviderId, id: string): Promise<string> {
    const { endpoints } = this.webhooks;
    this.webhooks.assertUsable();
    const receiver = endpoints.privateReceiver(id);
    if (!receiver || receiver.format !== `${provider}.v1` || !receiver.chatSecret) throw new ChatTransportError({ kind: 'auth' });
    try {
      const value = await endpoints.chatCredential(receiver);
      if (endpoints.privateReceiver(id)?.chatSecret?.sha256 !== receiver.chatSecret.sha256) throw new ChatTransportError({ kind: 'auth' });
      return value;
    } catch (error) {
      throw new ChatTransportError({ kind: error instanceof WebhookStateError && error.status === 503 ? 'transient' : 'auth' });
    }
  }
  private credentialTransport(provider: ChatProviderId, credential: string, binding?: import('./registry.ts').ChatTransportBinding): ChatTransport {
    const descriptor = chatProvider(provider, this.options.root);
    if (!descriptor) throw new ChatTransportError({ kind: 'blocked' });
    decodeChatCredentials(descriptor.credentials, credential);
    if (this.publicSelected(provider)) {
      return lazyChatTransport(async () => {
        await ensureChatTransport(this.options.root, provider);
        const selected = chatTransport(this.options.root, provider, credential, undefined, binding);
        if (!selected) throw new ChatTransportError({ kind: 'blocked' });
        return selected;
      }, () => !this.webhooks.stopped());
    }
    if (provider !== 'slack' && provider !== 'discord') {
      const transport = chatTransport(this.options.root, provider, credential, undefined, binding);
      if (!transport) throw new ChatTransportError({ kind: 'blocked' });
      return transport;
    }
    if (this.options.chatTransport) return this.options.chatTransport(provider, credential);
    if (provider === 'slack') return slackTransport(this.slackWire(async () => credential));
    return discordTransport(this.discordOptions(async () => credential));
  }
}

/** The stored settings of a receiver, as an update body that keeps every one of them. */
function storedSettings(receiver: PrivateReceiver) {
  return { name: receiver.name, format: receiver.format, profile: receiver.profile, preset: receiver.preset, events: [...receiver.events],
    includeScheduledFailures: receiver.includeScheduledFailures, scope: receiver.scope, graceSeconds: receiver.graceSeconds,
    allowLocalNetwork: receiver.allowLocalNetwork, ...(receiver.chatId !== undefined ? { chatId: receiver.chatId } : {}),
    ...(receiver.includeAgentExcerpt ? { includeAgentExcerpt: true as const } : {}) };
}

/** Delays encrypted credential reads until use; core guards still fence every effect. */
function lazyChatTransport(resolve: () => Promise<ChatTransport>, valid: () => boolean): ChatTransport {
  const current = async () => { if (!valid()) throw new ChatTransportError({ kind: 'blocked' }); return (await resolve()).guarded(valid); };
  return {
    identify: async signal => (await current()).identify(signal),
    inspect: async id => (await current()).inspect(id),
    send: async (...args) => (await current()).send(...args),
    clearButtons: async (...args) => (await current()).clearButtons(...args),
    acknowledge: async (...args) => (await current()).acknowledge(...args),
    isMember: async (...args) => (await current()).isMember(...args),
    guarded: check => lazyChatTransport(resolve, () => valid() && check()),
    connect: (journal, options, now) => {
      let connection: ChatConnection | undefined, stopped = false;
      let starting: Promise<void> | undefined;
      return {
        start: () => { starting ??= current().then(transport => { if (!stopped) { connection = transport.connect(journal, options, now); connection.start(); } }).catch(() => options.onHealth({ state: 'blocked' })); },
        stop: async () => { stopped = true; await starting; await connection?.stop(); },
        health: () => connection?.health() ?? { state: 'stopped' },
      };
    },
  };
}
