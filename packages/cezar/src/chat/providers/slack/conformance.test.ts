import { providerConformance } from '../../test-support/conformance.testkit.ts';
import { slackTransport } from './transport.ts';
import { slackPresentation } from './presentation.ts';
import type { ChatMessage } from '../../provider.ts';
providerConformance('Slack real adapter over simulated Web API', {
 id: 'slack', botId: 'T1:U1', userId: 'U2', privateChat: 'private:T1:U1:D1', groupChat: 'group:T1:U1:C1', presentation: slackPresentation,
 messageId: index => `1700000000.${String(index).padStart(6, '0')}`,
 session(send) {
  return slackTransport({
   socket() { throw new Error('Not used by core conformance'); },
   async call(method, body, _signal, valid) {
    if (valid && !valid()) throw new Error('fenced');
    if (method === 'auth.test') return { team_id: 'T1', user_id: 'U1' };
    if (method === 'chat.update') return { ok: true };
    if (method === 'conversations.info') return { channel: { id: body.channel, is_im: body.channel === 'D1', is_member: true, user: 'U2' } };
    if (method === 'conversations.members') return { members: ['U1', 'U2'] };
    if (method === 'chat.postMessage') {
     const blocks = body.blocks as Array<{ type: string; elements?: Array<{ text: { text: string }; value: string }> }> | undefined;
     const buttons = blocks?.find(block => block.type === 'actions')?.elements?.map(button => ({ text: button.text.text, data: button.value }));
     const message: ChatMessage = { text: String(body.text), ...(buttons ? { buttons: [buttons] } : {}) };
     const receipt = await send(`${body.channel === 'D1' ? 'private' : 'group'}:T1:U1:${body.channel}`, message);
     return { channel: body.channel, ts: receipt.messageId };
    }
    throw new Error('Unexpected method');
   },
  });
 },
});
