import { TelegramSendBudget } from './send-budget.ts';
import { TelegramBindings, readBinding } from './bindings.ts';
import { stateFingerprint } from './recovery.ts';
import type { BotBinding } from './state.ts';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, unlink } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { z } from 'zod';
import {
  telegramPairingInputSchema, telegramPairingConfirmSchema, telegramInboundReceiverPatchSchema, telegramInboundGrantPatchSchema, telegramInboundActivityResponseSchema, telegramInboundActivityQuerySchema,
  type TelegramInboundStateResponse, type TelegramPairingCreated, type TelegramPairingStatus,
} from '@open-mercato/cezar-contract';
import type { PrivateReceiver } from '../webhooks/endpoints.ts';
import { assertNoSymlink, statePath, syncDirectory } from '../webhooks/storage.ts';
import { telegramUnavailableReason } from './availability.ts';
import { BotLease } from './ownership.ts';
import { freshState, InboundStateStore, readInboundState, type InboundState, type InboundGrant } from './state.ts';
import { Pairings } from './pairing.ts';
import { receiverEligible } from './authorization.ts';
import { TelegramBotRuntime } from './runtime.ts';
import type { TelegramCall } from './client.ts';
import type { ConversationDependencies } from './conversation.ts';

export { TelegramInboundFailure } from './errors.ts';
import { TelegramInboundFailure } from './errors.ts';
interface Dependencies extends Pick<ConversationDependencies, 'context' | 'deliver' | 'prepareControl' | 'episode' | 'now'> {
  projectId: string; root: string; installationId: string; directory: string; mode: 'local' | 'hosted'; dryRun?: boolean;
  receivers(): PrivateReceiver[]; call(receiverId: string): TelegramCall; changed(): void;
}
interface Bot { budget: TelegramSendBudget; state: InboundStateStore; lease: BotLease; runtime?: TelegramBotRuntime; starting?: Promise<void> }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fatal = new Set(['conflict', 'credentials-unavailable', 'blocked'] as const);
const isFatal = (state: string): state is 'conflict' | 'credentials-unavailable' | 'blocked' => fatal.has(state as never);
const meSchema = z.object({ id: z.number().int().positive().safe(), username: z.string().regex(/^[A-Za-z0-9_]{1,64}$/) });

/** Project configuration owns bot leases; polling is a replaceable child of that ownership. */
export class TelegramInbound {
  readonly pairings: Pairings;
  private damaged = new Map<string, { binding: BotBinding; revision?: string }>();
  private resets = new Set<Promise<unknown>>();
  private maintenance = new Set<string>();
  private bots = new Map<string, Bot>();
  private opening = new Map<string, Promise<Bot>>();
  private snapshots = new Map<string, InboundState>();
  private replacements = new Map<string, { botId: string; targetRevision: string }>();
  private discovered = new Map<string, string>();
  private confirmed = new Map<string, { botId: string; receiverId: string; until: number }>();
  private closed = false;
  private readonly now: () => number;
  constructor(private readonly deps: Dependencies) {
    this.now = deps.now ?? Date.now; this.pairings = new Pairings(this.now);
    if (realpathSync(deps.root) !== deps.root) throw new TelegramInboundFailure(503, 'noncanonical_root');
  }
  private reason(): 'hosted' | 'webhooks_off' | 'flag_off' | 'unavailable' | undefined {
    return this.closed ? 'unavailable' : telegramUnavailableReason(this.deps.mode);
  }
  private gate(): void { const reason = this.reason(); if (reason) throw new TelegramInboundFailure(503, reason); }
  private receiver(id: string): PrivateReceiver {
    const receiver = this.deps.receivers().find(receiver => receiver.id === id);
    if (!receiver) throw new TelegramInboundFailure(404, 'receiver_missing'); return receiver;
  }
  private eligible(id: string): PrivateReceiver {
    const receiver = this.receiver(id);
    if (!receiverEligible(receiver) || !/^-?[1-9][0-9]*$/.test(receiver.telegramChatId ?? '')) throw new TelegramInboundFailure(409, 'receiver_ineligible');
    return receiver;
  }
  private async checkGroup(receiver: PrivateReceiver, consent?: true, botId?: string): Promise<void> {
    if (!receiver.telegramChatId?.startsWith('-')) return;
    if (!consent) throw new TelegramInboundFailure(400, 'group_visibility_required');
    const chat = z.object({ id: z.number().int().safe(), type: z.enum(['group', 'supergroup']), is_forum: z.boolean().optional() })
      .safeParse(await this.deps.call(receiver.id)('getChat', { chat_id: receiver.telegramChatId }));
    if (!chat.success || chat.data.is_forum || String(chat.data.id) !== receiver.telegramChatId) throw new TelegramInboundFailure(409, 'group_ineligible');
    if (botId) await this.checkGroupMember(receiver, botId, 'bot_not_group_member');
  }
  private async checkGroupMember(receiver: PrivateReceiver, userId: string, failure: 'bot_not_group_member' | 'candidate_not_group_member'): Promise<void> {
    const member = z.object({ user: z.object({ id: z.number().int().positive().safe() }), status: z.enum(['creator', 'administrator', 'member', 'restricted', 'left', 'kicked']), is_member: z.boolean().optional() })
      .safeParse(await this.deps.call(receiver.id)('getChatMember', { chat_id: receiver.telegramChatId, user_id: Number(userId) }));
    if (!member.success || ['left', 'kicked'].includes(member.data.status) || (member.data.status === 'restricted' && member.data.is_member !== true)
      || member.data.user.id !== Number(userId)) throw new TelegramInboundFailure(409, failure);
  }
  private snapshot(botId: string): InboundState | undefined { return this.bots.get(botId)?.state.snapshot() ?? this.snapshots.get(botId); }
  private botFor(receiverId: string): string | undefined {
    for (const botId of new Set([...this.snapshots.keys(), ...this.bots.keys()])) if (this.snapshot(botId)?.receivers.some(receiver => receiver.receiverId === receiverId)) return botId;
    return this.discovered.get(receiverId);
  }
  /** Reuse only getMe-verified credentials, including outbound-only receivers of that bot. */
  sendBudget(receiver: PrivateReceiver): TelegramSendBudget | undefined {
    if (this.reason() || receiver.format !== 'telegram.v1' || !receiver.telegramSecret?.sha256) return;
    for (const [id, bot] of this.bots) {
      if (this.maintenance.has(id) || this.damaged.has(id)) continue;
      try { bot.state.assertReady(); } catch { continue; }
      if (bot.state.snapshot().receivers.some(bound => bound.credentialFingerprint === receiver.telegramSecret!.sha256)) return bot.budget;
    }
    return undefined;
  }
  private revision(botId: string): string {
    const state = this.snapshot(botId);
    return digest([state?.binding.generation ?? 'missing', state?.configGeneration ?? 'missing',
      this.deps.receivers().filter(receiver => state?.receivers.some(binding => binding.receiverId === receiver.id) || this.discovered.get(receiver.id) === botId)
        .map(receiver => [receiver.id, receiver.revision, receiver.deliveryRevision]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))]);
  }
  private receiverRevision(receiver: PrivateReceiver): string {
    const botId = this.botFor(receiver.id);
    const base = botId ? this.revision(botId) : digest([this.deps.projectId, this.deps.installationId, this.deps.root, receiver.id, receiver.revision, receiver.deliveryRevision, 'missing']);
    const pending = this.replacements.get(receiver.id);
    return pending ? digest([base, pending.botId, this.revision(pending.botId)]) : base;
  }
  private expect(botId: string, revision: string): void {
    if (this.revision(botId) !== revision) throw new TelegramInboundFailure(409, 'revision_conflict');
  }
  /** Session bookkeeping for receivers deleted from the project must not outlive them. */
  private prune(): void {
    const live = new Set(this.deps.receivers().map(receiver => receiver.id));
    for (const id of this.discovered.keys()) if (!live.has(id)) this.discovered.delete(id);
    for (const id of this.replacements.keys()) if (!live.has(id)) this.replacements.delete(id);
    for (const [id, value] of this.confirmed) if (value.until <= this.now() || !live.has(value.receiverId)) this.confirmed.delete(id);
  }
  private receiverState(receiver: PrivateReceiver, botId: string | undefined, state: InboundState | undefined): TelegramInboundStateResponse['receivers'][number]['state'] {
    const binding = state?.receivers.find(binding => binding.receiverId === receiver.id);
    if (botId && this.damaged.has(botId)) return 'blocked';
    if (binding?.suspendedReason) return 'suspended';
    if (binding?.enabled && state?.grants.some(grant => grant.receiverId === receiver.id)) {
      if (!receiverEligible(receiver) || receiver.deliveryRevision !== binding.deliveryRevision || receiver.telegramChatId !== binding.chatId) return 'suspended';
      const runtime = botId ? this.bots.get(botId)?.runtime : undefined, health = runtime?.health().state;
      return !runtime?.running ? 'stopped' : health && isFatal(health) ? health : 'active';
    }
    return this.pairings.hasReceiver(receiver.id) ? 'pairing' : 'disabled';
  }
  list(): TelegramInboundStateResponse {
    this.prune();
    const reason = this.reason(), states = [...new Set([...this.snapshots.keys(), ...this.bots.keys()])].flatMap(id => { const state = this.snapshot(id); return state ? [state] : []; });
    return { available: !reason, ...(reason ? { reason } : {}),
      receivers: this.deps.receivers().filter(receiver => receiver.format === 'telegram.v1').map(receiver => {
        const botId = this.botFor(receiver.id), state = botId ? this.snapshot(botId) : undefined;
        const binding = state?.receivers.find(binding => binding.receiverId === receiver.id);
        return { receiverId: receiver.id, ...(botId ? { botId } : {}), inboundRevision: this.receiverRevision(receiver),
          state: this.receiverState(receiver, botId, state), ...(binding ? { generation: binding.generation } : {}) };
      }),
      bots: [...states.filter(state => !this.damaged.has(state.botId)).map(state => ({ botId: state.botId, inboundRevision: this.revision(state.botId), health: this.bots.get(state.botId)?.runtime?.health() ?? { state: 'stopped' as const } })),
        ...[...this.damaged].map(([botId, damage]) => ({ botId, ...(damage.revision ? { inboundRevision: damage.revision } : {}), health: { state: 'blocked' as const } }))],
      grants: states.filter(state => !this.damaged.has(state.botId)).flatMap(state => state.grants),
    };
  }
  private ownBinding(binding: BotBinding): boolean {
    return binding.root === this.deps.root && binding.projectId === this.deps.projectId && binding.installationId === this.deps.installationId;
  }
  async load(): Promise<void> {
    let files: string[] = [];
    assertNoSymlink(this.deps.directory);
    try { files = await readdir(this.deps.directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const diagnostics = new TelegramBindings({ mode: () => this.deps.mode, projects: async () => [], dryRun: this.deps.dryRun, visibleProject: () => this.deps.projectId });
    const bindings = await diagnostics.scan();
    const ids = new Set([...files.filter(file => /^[1-9][0-9]{0,15}\.json$/.test(file)).slice(0, 100).map(file => file.slice(0, -5)), ...bindings.bindings.map(binding => binding.botId)]);
    for (const botId of ids) {
      const binding = await readBinding(botId, this.deps.dryRun === true).catch(() => undefined);
      if (!binding || !this.ownBinding(binding)) continue;
      try {
        const state = await readInboundState(this.deps.directory, botId);
        if (state && this.ownBinding(state.binding) && state.binding.generation === binding.generation) { this.snapshots.set(botId, state); continue; }
      } catch { /* Never salvage grants from malformed state. */ }
      const revision = await stateFingerprint(this.deps.directory, botId, binding).catch(() => undefined);
      this.damaged.set(botId, { binding, ...(revision ? { revision } : {}) });
    }
  }
  /** Passive status refresh can recompute reset eligibility, never starts a consumer. */
  async refreshDiagnostics(): Promise<void> {
    for (const [botId, bot] of this.bots) {
      try { bot.state.assertReady(); }
      catch { if (!this.damaged.has(botId)) this.damaged.set(botId, { binding: bot.state.snapshot().binding }); }
    }
    for (const [botId, damage] of this.damaged) {
      if (this.maintenance.has(botId)) continue;
      const binding = await readBinding(botId, this.deps.dryRun === true).catch(() => undefined);
      if (!binding || !this.ownBinding(binding) || binding.generation !== damage.binding.generation) { delete damage.revision; continue; }
      damage.revision = await stateFingerprint(this.deps.directory, botId, binding).catch(() => undefined);
    }
  }
  private async open(botId: string, create = false): Promise<Bot> {
    this.gate();
    if (this.maintenance.has(botId)) throw new TelegramInboundFailure(409, 'bot_busy');
    if (this.damaged.has(botId)) throw new TelegramInboundFailure(409, 'reset_required');
    const current = this.bots.get(botId); if (current) { current.lease.assertOwner(); return current; }
    const pending = this.opening.get(botId); if (pending) return pending;
    const work = (async () => {
      const lease = await BotLease.acquire(botId, this.deps.dryRun);
      try {
        this.gate();
        assertNoSymlink(this.deps.directory); await mkdir(this.deps.directory, { recursive: true, mode: 0o700 }); await chmod(this.deps.directory, 0o700);
        let saved = await readInboundState(this.deps.directory, botId);
        // State without a binding is an interrupted disconnect; pairing starts over instead of stranding the bot.
        if (saved && create && !await lease.binding()) saved = undefined;
        if (saved) await lease.validate(saved.binding);
        else {
          if (!create) throw new TelegramInboundFailure(409, 'state_missing');
          const binding = await lease.bind({ projectId: this.deps.projectId, root: this.deps.root, installationId: this.deps.installationId });
          saved = freshState(botId, binding);
        }
        if (saved.binding.root !== this.deps.root || saved.binding.projectId !== this.deps.projectId || saved.binding.installationId !== this.deps.installationId) throw new TelegramInboundFailure(409, 'foreign_state');
        const state = InboundStateStore.persisted(this.deps.directory, saved, () => lease.assertOwnerCached(), () => lease.assertOwner());
        await state.recover(); this.gate();
        const bot = { state, lease, budget: new TelegramSendBudget(this.now) }; this.bots.set(botId, bot); return bot;
      } catch (error) { await lease.release(); throw error; }
    })();
    this.opening.set(botId, work);
    try { return await work; } finally { this.opening.delete(botId); }
  }
  async start(): Promise<void> {
    if (this.reason()) return;
    // `snapshots` is only the state read during load. A pairing or reset can
    // change the live store afterwards, so never use it as the start decision.
    const botIds = new Set([...this.snapshots.keys(), ...this.bots.keys()]);
    for (const botId of botIds) {
      try {
        const state = this.snapshot(botId), health = this.bots.get(botId)?.runtime?.health().state;
        if (!state || !state.grants.length || !state.receivers.some(receiver => receiver.enabled)) continue;
        // §9.5: a conflict, revoked token or blocked poller waits for an explicit enable, pair or reset.
        if (health && isFatal(health)) continue;
        const bot = await this.open(botId); await this.run(botId, bot);
      } catch { this.deps.changed(); }
    }
  }
  /** `explicit`: a user action (pair, enable, reset) may restart a runtime stopped by a fatal state. */
  private async run(botId: string, bot: Bot, explicit = false): Promise<void> {
    if (bot.starting) return bot.starting;
    const work = this.startBot(botId, bot, explicit); bot.starting = work;
    try { await work; } finally { bot.starting = undefined; }
  }
  private async startBot(botId: string, bot: Bot, explicit: boolean): Promise<void> {
    const health = bot.runtime?.running ? bot.runtime.health().state : undefined;
    if (health === 'polling' || health === 'backoff' || (!explicit && health && isFatal(health))) return;
    if (bot.runtime && !await bot.runtime.stop()) throw new TelegramInboundFailure(409, 'bot_busy');
    const state = bot.state.snapshot();
    // A persisted binding can outlive a receiver edit. Pick an anchor only
    // when the current receiver still agrees with every inbound identity field.
    const receiverId = state.receivers.find(binding => {
      const receiver = this.deps.receivers().find(receiver => receiver.id === binding.receiverId);
      return receiverEligible(receiver) && receiver.telegramChatId === binding.chatId
        && receiver.deliveryRevision === binding.deliveryRevision
        && receiver.telegramSecret?.sha256 === binding.credentialFingerprint;
    })?.receiverId;
    if (!receiverId) return;
    const call = this.deps.call(receiverId);
    bot.runtime = new TelegramBotRuntime({ ...this.deps, botId, projectRoot: this.deps.root, state: bot.state, lease: bot.lease, budget: bot.budget, pairings: this.pairings, call, enabled: () => !this.reason(),
      receiver: id => this.deps.receivers().find(receiver => receiver.id === id),
      assertCredentials: async () => {
        this.gate();
        const bound = bot.state.snapshot().receivers.find(receiver => receiver.receiverId === receiverId), receiver = this.eligible(receiverId);
        if (receiver.telegramSecret?.sha256 !== bound?.credentialFingerprint) throw new TelegramInboundFailure(503, 'credentials_unavailable');
      } });
    await bot.runtime.start();
  }
  async pair(raw: z.input<typeof telegramPairingInputSchema>): Promise<TelegramPairingCreated> {
    this.gate(); const input = telegramPairingInputSchema.parse(raw), receiver = this.eligible(input.receiverId);
    if (this.receiverRevision(receiver) !== input.expectedRevision) throw new TelegramInboundFailure(409, 'revision_conflict');
    const before = receiver.revision;
    const me = meSchema.parse(await this.deps.call(receiver.id)('getMe', {})); this.gate();
    await this.checkGroup(receiver, input.groupVisibilityAccepted, String(me.id));
    if (this.eligible(receiver.id).revision !== before) throw new TelegramInboundFailure(409, 'revision_conflict');
    const botId = String(me.id), known = this.botFor(receiver.id);
    const bot = await this.open(botId, true);
    const targetRevision = this.revision(botId);
    if (known && known !== botId) {
      if (!input.replaceExisting) throw new TelegramInboundFailure(409, 'replacement_required');
      const pending = this.replacements.get(receiver.id);
      if (!pending || pending.botId !== botId || pending.targetRevision !== targetRevision) {
        this.replacements.set(receiver.id, { botId, targetRevision });
        throw new TelegramInboundFailure(409, 'revision_required');
      }
      const previous = await this.open(known);
      await previous.state.change(state => {
        this.gate();
        if (this.receiverRevision(this.eligible(receiver.id)) !== input.expectedRevision || this.revision(botId) !== targetRevision) throw new TelegramInboundFailure(409, 'revision_conflict');
        state.receivers = state.receivers.filter(binding => binding.receiverId !== receiver.id);
        state.grants = state.grants.filter(grant => grant.receiverId !== receiver.id);
        state.correlations = state.correlations.filter(correlation => correlation.receiverId !== receiver.id);
        state.configGeneration = randomUUID();
      });
      this.pairings.cancelReceiver(receiver.id);
    }
    if (!known && bot.state.snapshot().receivers.length) {
      this.discovered.set(receiver.id, botId); throw new TelegramInboundFailure(409, 'revision_required');
    }
    if (input.replaceExisting) this.pairings.cancelReceiver(receiver.id);
    let session: ReturnType<Pairings['create']>;
    try {
      session = this.pairings.create({ receiverId: receiver.id, botId, chatId: receiver.telegramChatId!, deliveryRevision: receiver.deliveryRevision }, me.username);
    } catch (error) {
      if (error instanceof Error && error.message === 'pairing_limit') throw new TelegramInboundFailure(409, 'pairing_limit');
      throw error;
    }
    try {
      await bot.state.change(state => {
        this.gate();
        if (known === botId && this.receiverRevision(this.eligible(receiver.id)) !== input.expectedRevision) throw new TelegramInboundFailure(409, 'revision_conflict');
        if (known && known !== botId && this.revision(botId) !== targetRevision) throw new TelegramInboundFailure(409, 'revision_conflict');
        const current = this.eligible(receiver.id); if (current.revision !== before) throw new TelegramInboundFailure(409, 'revision_conflict');
        if (state.receivers.some(binding => binding.chatId === current.telegramChatId && binding.receiverId !== current.id)) throw new TelegramInboundFailure(409, 'chat_conflict');
        if (input.replaceExisting) {
          state.receivers = state.receivers.filter(binding => binding.receiverId !== current.id);
          state.grants = state.grants.filter(grant => grant.receiverId !== current.id);
          state.correlations = state.correlations.filter(correlation => correlation.receiverId !== current.id);
        }
        if (!state.receivers.some(binding => binding.receiverId === current.id)) state.receivers.push({ receiverId: current.id, chatId: current.telegramChatId!, enabled: false,
          generation: randomUUID(), acceptAfter: this.now(), deliveryRevision: current.deliveryRevision, credentialFingerprint: current.telegramSecret!.sha256 });
        state.configGeneration = randomUUID();
      });
      this.discovered.set(receiver.id, botId); this.replacements.delete(receiver.id);
      await this.run(botId, bot, true); this.deps.changed();
      return { pairingId: session.session.id, expiresAt: session.session.expiresAt, deepLink: session.deepLink };
    } catch (error) {
      this.pairings.cancel(session.session.id);
      if (known && known !== botId) { this.discovered.set(receiver.id, botId); this.replacements.delete(receiver.id); }
      throw error;
    }
  }
  pairing(id: string): TelegramPairingStatus {
    if (this.reason()) throw new TelegramInboundFailure(404, 'pairing_expired');
    this.prune(); const confirmed = this.confirmed.get(id);
    if (confirmed) return { status: 'confirmed', inboundRevision: this.revision(confirmed.botId) };
    const session = this.pairings.get(id);
    if (!session) {
      const expired = this.pairings.wasExpired(id);
      if (expired) return { status: 'expired', inboundRevision: this.revision(expired.botId) };
      throw new TelegramInboundFailure(404, 'pairing_expired');
    }
    return { status: session.candidate ? 'candidate' : 'waiting', inboundRevision: this.revision(session.botId), ...(session.candidate ? { candidate: session.candidate } : {}) };
  }
  async confirm(id: string, raw: z.input<typeof telegramPairingConfirmSchema>): Promise<{ grant: InboundGrant; inboundRevision: string }> {
    this.gate(); const input = telegramPairingConfirmSchema.parse(raw), session = this.pairings.get(id);
    if (!session) throw new TelegramInboundFailure(404, 'pairing_expired');
    const bot = await this.open(session.botId);
    const candidate = session.candidate;
    const candidateReceiver = this.eligible(session.receiverId);
    if (!candidate || candidate.userId !== input.candidateUserId || candidateReceiver.telegramChatId !== session.chatId || candidateReceiver.deliveryRevision !== session.deliveryRevision)
      throw new TelegramInboundFailure(409, 'pairing_changed');
    if (session.chatId.startsWith('-') && input.comparisonVerified) await this.checkGroupMember(candidateReceiver, candidate.userId, 'candidate_not_group_member');
    const grant = await bot.state.change(state => {
      this.gate(); this.expect(session.botId, input.expectedRevision);
      const current = this.pairings.get(id), receiver = this.eligible(session.receiverId);
      if (!current?.candidate || current.candidate.userId !== input.candidateUserId || receiver.telegramChatId !== current.chatId || receiver.deliveryRevision !== current.deliveryRevision) throw new TelegramInboundFailure(409, 'pairing_changed');
      if (current.chatId.startsWith('-') && (!current.candidate.comparisonCode || !input.comparisonVerified)) throw new TelegramInboundFailure(400, 'comparison_required');
      const bound = state.receivers.find(binding => binding.receiverId === receiver.id)!;
      if (bound.chatId !== receiver.telegramChatId) throw new TelegramInboundFailure(409, 'chat_changed');
      if (state.grants.some(grant => grant.receiverId === receiver.id && grant.userId === current.candidate!.userId)) throw new TelegramInboundFailure(409, 'already_paired');
      if (state.grants.length >= 100) throw new TelegramInboundFailure(409, 'grant_limit');
      if (!bound.enabled) {
        bound.generation = randomUUID(); bound.acceptAfter = this.now();
      }
      delete bound.suspendedReason;
      bound.enabled = true; bound.deliveryRevision = receiver.deliveryRevision; bound.credentialFingerprint = receiver.telegramSecret!.sha256;
      const grant: InboundGrant = { id: randomUUID(), receiverId: receiver.id, chatId: bound.chatId, userId: current.candidate.userId, label: current.candidate.label,
        permissions: input.permissions ?? ['respond'], generation: randomUUID(), enableGeneration: bound.generation, approvedAt: this.now() };
      state.grants.push(grant); state.configGeneration = randomUUID(); return grant;
    });
    this.pairings.cancel(id); this.confirmed.set(id, { botId: session.botId, receiverId: session.receiverId, until: this.now() + 300_000 });
    this.bots.get(session.botId)?.runtime?.notify(candidate.userId, 'Access granted. Try /tasks to see this project’s tasks.');
    this.deps.changed();
    return { grant, inboundRevision: this.revision(session.botId) };
  }
  cancelPairing(id: string): { cancelled: true } { this.gate(); this.pairings.cancel(id); this.deps.changed(); return { cancelled: true }; }
  async revoke(id: string, expectedRevision: string): Promise<{ revoked: true; inboundRevision: string }> {
    this.gate(); const botId = this.list().bots.find(bot => this.snapshot(bot.botId)?.grants.some(grant => grant.id === id))?.botId;
    if (!botId) throw new TelegramInboundFailure(404, 'grant_missing'); const bot = await this.open(botId);
    await bot.state.change(state => {
      this.gate(); this.expect(botId, expectedRevision);
      const grant = state.grants.find(grant => grant.id === id); if (!grant) throw new TelegramInboundFailure(404, 'grant_missing');
      state.grants = state.grants.filter(grant => grant.id !== id);
      if (!state.grants.some(other => other.receiverId === grant.receiverId)) state.receivers.find(binding => binding.receiverId === grant.receiverId)!.enabled = false;
      state.configGeneration = randomUUID();
    });
    this.deps.changed(); return { revoked: true, inboundRevision: this.revision(botId) };
  }
  async permissions(id: string, raw: z.input<typeof telegramInboundGrantPatchSchema>): Promise<{ grant: InboundGrant; inboundRevision: string }> {
    this.gate(); const input = telegramInboundGrantPatchSchema.parse(raw);
    const botId = this.list().bots.find(bot => this.snapshot(bot.botId)?.grants.some(grant => grant.id === id))?.botId;
    if (!botId) throw new TelegramInboundFailure(404, 'grant_missing');
    const bot = await this.open(botId);
    const grant = await bot.state.change(state => {
      this.gate(); this.expect(botId, input.expectedRevision);
      const grant = state.grants.find(grant => grant.id === id);
      if (!grant) throw new TelegramInboundFailure(404, 'grant_missing');
      // Only this person's older messages lose effect; others on the receiver keep theirs.
      grant.permissions = input.permissions; grant.generation = randomUUID(); grant.approvedAt = this.now();
      state.configGeneration = randomUUID(); return grant;
    });
    this.deps.changed(); return { grant, inboundRevision: this.revision(botId) };
  }
  async setEnabled(receiverId: string, raw: z.input<typeof telegramInboundReceiverPatchSchema>): Promise<{ state: 'active' | 'disabled'; inboundRevision: string }> {
    this.gate(); const input = telegramInboundReceiverPatchSchema.parse(raw), botId = this.botFor(receiverId);
    if (!botId) throw new TelegramInboundFailure(404, 'binding_missing');
    const bot = await this.open(botId);
    if (input.enabled) {
      const receiver = this.eligible(receiverId), before = receiver.revision;
      const me = meSchema.parse(await this.deps.call(receiverId)('getMe', {}));
      await this.checkGroup(receiver, input.groupVisibilityAccepted, String(me.id));
      if (String(me.id) !== botId || this.receiver(receiverId).revision !== before) throw new TelegramInboundFailure(409, 'receiver_changed');
    }
    await bot.state.change(state => {
      this.gate(); this.expect(botId, input.expectedRevision);
      const bound = state.receivers.find(binding => binding.receiverId === receiverId);
      if (!bound) throw new TelegramInboundFailure(404, 'binding_missing');
      if (input.enabled) {
        const receiver = this.eligible(receiverId);
        if (receiver.telegramChatId !== bound.chatId || !state.grants.some(grant => grant.receiverId === receiverId)) throw new TelegramInboundFailure(409, 'pairing_required');
        delete bound.suspendedReason;
        bound.generation = randomUUID(); bound.acceptAfter = this.now(); bound.deliveryRevision = receiver.deliveryRevision; bound.credentialFingerprint = receiver.telegramSecret!.sha256;
        for (const grant of state.grants) if (grant.receiverId === receiverId) grant.enableGeneration = bound.generation;
      }
      bound.enabled = input.enabled; state.correlations = state.correlations.filter(correlation => correlation.receiverId !== receiverId);
      state.configGeneration = randomUUID();
    });
    if (input.enabled) await this.run(botId, bot, true);
    else if (!bot.state.snapshot().receivers.some(binding => binding.enabled)) await bot.runtime?.stop();
    this.deps.changed(); return { state: input.enabled ? 'active' : 'disabled', inboundRevision: this.revision(botId) };
  }
  async reset(botId: string, expectedRevision: string): Promise<{ reset: true; inboundRevision: string }> {
    this.gate();
    if (this.damaged.has(botId)) {
      const work = this.resetDamaged(botId, expectedRevision); this.resets.add(work);
      try { return await work; } finally { this.resets.delete(work); }
    }
    const bot = await this.open(botId); this.expect(botId, expectedRevision);
    this.maintenance.add(botId);
    try {
      if (bot.runtime && !await bot.runtime.stop()) throw new TelegramInboundFailure(409, 'bot_busy');
      await bot.state.change(state => {
        this.gate(); this.expect(botId, expectedRevision);
        for (const bound of state.receivers) { bound.enabled = false; bound.generation = randomUUID(); bound.acceptAfter = this.now(); this.pairings.cancelReceiver(bound.receiverId); }
        state.grants = []; state.correlations = []; state.journal = []; state.epoch = randomUUID(); state.nextOffset = null; state.phase = 'probing'; state.lastUpdateAt = null;
        state.configGeneration = randomUUID();
      });
    } finally { this.maintenance.delete(botId); }
    this.deps.changed(); return { reset: true, inboundRevision: this.revision(botId) };
  }
  private async resetDamaged(botId: string, expectedRevision: string): Promise<{ reset: true; inboundRevision: string }> {
    const damage = this.damaged.get(botId)!;
    if (!damage.revision) throw new TelegramInboundFailure(409, 'reset_unavailable');
    if (damage.revision !== expectedRevision) throw new TelegramInboundFailure(409, 'revision_conflict');
    if (this.maintenance.has(botId)) throw new TelegramInboundFailure(409, 'bot_busy');
    this.maintenance.add(botId);
    let lease: BotLease | undefined;
    const existing = this.bots.get(botId);
    try {
      if (existing?.runtime && !await existing.runtime.stop()) throw new TelegramInboundFailure(409, 'bot_busy');
      await existing?.state.drain();
      for (const receiver of existing?.state.snapshot().receivers ?? []) this.pairings.cancelReceiver(receiver.receiverId);
      lease = existing?.lease ?? await BotLease.acquire(botId, this.deps.dryRun); this.gate();
      await lease.validate(damage.binding);
      if (!this.ownBinding(damage.binding) || await stateFingerprint(this.deps.directory, botId, damage.binding) !== expectedRevision) throw new TelegramInboundFailure(409, 'revision_conflict');
      assertNoSymlink(this.deps.directory); await mkdir(this.deps.directory, { recursive: true, mode: 0o700 }); await chmod(this.deps.directory, 0o700);
      const owned = lease;
      const state = InboundStateStore.persisted(this.deps.directory, freshState(botId, damage.binding), () => owned.assertOwnerCached(), () => owned.assertOwner());
      await state.change(() => { this.gate(); });
      this.bots.set(botId, { lease, state, budget: existing?.budget ?? new TelegramSendBudget(this.now) }); lease = undefined;
      this.damaged.delete(botId); this.snapshots.delete(botId); this.deps.changed();
      return { reset: true, inboundRevision: this.revision(botId) };
    } finally { this.maintenance.delete(botId); if (!existing) await lease?.release(); }
  }
  async disconnect(botId: string, expectedRevision: string): Promise<{ disconnected: true; inboundRevision: string }> {
    const result = await this.reset(botId, expectedRevision), bot = this.bots.get(botId);
    if (!bot) throw new TelegramInboundFailure(404, 'binding_missing');
    const binding = bot.state.snapshot().binding;
    this.maintenance.add(botId);
    try {
      await bot.state.drain();
      // State before binding: a crash in between leaves a resettable binding, never an unpairable orphan state.
      await unlink(statePath(this.deps.directory, `${botId}.json`)).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
      await syncDirectory(this.deps.directory);
      await bot.lease.disconnect(binding);
    } catch (error) {
      // The lease is released below, so this store is dead; as damaged, a retried disconnect resets and finishes.
      const revision = await stateFingerprint(this.deps.directory, botId, binding).catch(() => undefined);
      this.damaged.set(botId, { binding, ...(revision ? { revision } : {}) }); this.deps.changed();
      throw error;
    } finally {
      this.bots.delete(botId); this.snapshots.delete(botId); this.maintenance.delete(botId);
      for (const [id, discovered] of this.discovered) if (discovered === botId) this.discovered.delete(id);
      await bot.lease.release();
    }
    this.deps.changed(); return { disconnected: true, inboundRevision: result.inboundRevision };
  }
  /** A lost correlation never changes an already committed outbound delivery result. */
  async recordDelivery(source: import('../webhooks/source.ts').WebhookSource, receiverId: string, deliveryRevision: number,
    receipt: { messageId: number; chatId: string }): Promise<boolean> {
    if (this.reason() || source.projectId !== this.deps.projectId || source.installationId !== this.deps.installationId) return false;
    const botId = this.botFor(receiverId), bot = botId ? this.bots.get(botId) : undefined;
    if (!bot) return false;
    return bot.state.change(state => {
      const receiver = this.deps.receivers().find(receiver => receiver.id === receiverId);
      const bound = state.receivers.find(binding => binding.receiverId === receiverId);
      if (this.reason() || !receiverEligible(receiver) || !bound?.enabled || !receiver
        || receiver.deliveryRevision !== deliveryRevision || bound.deliveryRevision !== deliveryRevision
        || bound.chatId !== receipt.chatId || receiver.telegramChatId !== receipt.chatId
        || bound.credentialFingerprint !== receiver.telegramSecret?.sha256) return false;
      state.correlations = state.correlations.filter(row => row.chatId !== receipt.chatId || row.messageId !== receipt.messageId);
      state.correlations.push({ receiverId, chatId: receipt.chatId, messageId: receipt.messageId, deliveryRevision,
        bindingGeneration: state.binding.generation, enableGeneration: bound.generation,
        runId: source.snapshot.id, type: source.type, sequence: source.sequence, episodeId: source.episodeId,
        continuation: source.snapshot.continuation, createdAt: this.now(),
        ...(source.snapshot.attentionRequest ? { requestId: source.snapshot.attentionRequest.requestId, askedAt: source.snapshot.attentionRequest.askedAt } : {}) });
      return true;
    });
  }
  activity(raw: z.input<typeof telegramInboundActivityQuerySchema>): z.infer<typeof telegramInboundActivityResponseSchema> {
    const input = telegramInboundActivityQuerySchema.parse(raw);
    if (this.reason()) return { entries: [] };
    const entries = [...new Set([...this.bots.keys(), ...this.snapshots.keys()])].flatMap(id => this.snapshot(id)?.journal ?? [])
      .filter(entry => entry.state !== 'claimed' && (!input.receiverId || input.receiverId === entry.receiverId))
      .sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
    const start = input.before ? entries.findIndex(entry => entry.id === input.before) + 1 : 0;
    if (input.before && !start) throw new TelegramInboundFailure(400, 'invalid_cursor');
    const page = entries.slice(start, start + input.limit);
    return telegramInboundActivityResponseSchema.parse({ entries: page,
      ...(start + input.limit < entries.length && page.length ? { nextCursor: page.at(-1)!.id } : {}) });
  }
  async dispose(): Promise<void> {
    this.closed = true; await Promise.allSettled([...this.opening.values(), ...this.resets]);
    await Promise.allSettled([...this.bots.values()].map(async bot => {
      if (bot.runtime && !await bot.runtime.stop()) return;
      await bot.state.drain(); await bot.lease.release();
    }));
  }
}
