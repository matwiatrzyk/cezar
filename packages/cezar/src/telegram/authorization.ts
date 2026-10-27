import type { PrivateReceiver } from '../webhooks/endpoints.ts';
import type { RunRecord } from '../runs/store.ts';
import { runLifecycleSnapshot } from '../runs/lifecycle.ts';
import type { Correlation, InboundGrant, InboundState } from './state.ts';
import { freshMessage } from './protocol.ts';

export function receiverEligible(receiver: PrivateReceiver | undefined): receiver is PrivateReceiver {
  return receiver?.format === 'telegram.v1' && receiver.state === 'active' && receiver.lastTest === 'success'
    && receiver.profile === 'standard' && (receiver.preset === 'attention' || receiver.preset === 'all' || receiver.events.includes('task.attention_required')) && receiver.telegramSecret !== undefined;
}
export function authorize(state: InboundState, chatId: string, userId: string, receiver: (id: string) => PrivateReceiver | undefined): InboundGrant | undefined {
  const binding = state.receivers.find(binding => binding.chatId === chatId && binding.enabled);
  if (!binding) return undefined;
  const current = receiver(binding.receiverId);
  if (!receiverEligible(current) || current.telegramChatId !== chatId || current.deliveryRevision !== binding.deliveryRevision
    || current.telegramSecret!.sha256 !== binding.credentialFingerprint) return undefined;
  return state.grants.find(grant => grant.receiverId === binding.receiverId && grant.chatId === chatId && grant.userId === userId
    && grant.enableGeneration === binding.generation && grant.permissions.includes('respond'));
}
export function grantFresh(state: InboundState, grant: InboundGrant, messageDate: number, now: number): boolean {
  const binding = state.receivers.find(binding => binding.receiverId === grant.receiverId);
  return !!binding && freshMessage(messageDate, Math.max(binding.acceptAfter, grant.approvedAt), now);
}
export function correlationCurrent(state: InboundState, correlation: Correlation, run: RunRecord, episodeId: string | undefined): boolean {
  const binding = state.receivers.find(binding => binding.receiverId === correlation.receiverId);
  return !!binding && binding.enabled && binding.generation === correlation.enableGeneration
    && state.binding.generation === correlation.bindingGeneration && binding.deliveryRevision === correlation.deliveryRevision
    && run.id === correlation.runId && !run.archived && run.status === 'waiting'
    && correlation.type === 'task.attention_required' && episodeId !== undefined && episodeId === correlation.episodeId
    && runLifecycleSnapshot(run).continuation === correlation.continuation
    && (correlation.requestId === undefined || (run.attentionRequest?.requestId === correlation.requestId && run.attentionRequest.askedAt === correlation.askedAt));
}
