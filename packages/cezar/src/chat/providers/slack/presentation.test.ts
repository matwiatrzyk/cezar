import { expect, it } from 'vitest';
import { chatAccessGrantedText, chatHelp } from '../../conversation.ts';
import { normalizeSlackEnvelope } from './normalize.ts';
import { slackDiscoveryCommand, slackPresentation } from './presentation.ts';


const bot = 'TTEAM:UREALBOT';
const normalize = (text: string, group = true) => normalizeSlackEnvelope({
 envelope_id: 'e', type: 'events_api', payload: {
  team_id: 'TTEAM', event_id: 'E1', authorizations: [{ user_id: 'UREALBOT', is_bot: true }],
  event: { type: 'message', channel: group ? 'CCHAN' : 'DDM', user: 'UACTOR', text, ts: '1700000000.000001' },
 },
}, bot, async () => ({ id: group ? 'group:TTEAM:UREALBOT:CCHAN' : 'private:TTEAM:UREALBOT:DDM', kind: group ? 'group' : 'private', eligible: true }), 1700000000000);

it('renders actionable picker instructions in group help and private access-granted notices', async () => {
 const help = slackPresentation.formatText(chatHelp(slackPresentation, bot), 4000, bot);
 const access = slackPresentation.formatText(chatAccessGrantedText(slackPresentation, 'group:TTEAM:UREALBOT:CCHAN', bot), 4000, bot);
 for (const text of [help, access]) {
  expect(text).toContain('select it from Slack’s @\u200b picker');
  expect(text).toContain('followed by cezar tasks');
  expect(text).not.toContain('<@UREALBOT>');
 }
 expect(help).toContain('followed by cezar status &lt;task&gt;');
 expect(help).not.toContain('cezar task ');
 const displayed = [...help.matchAll(/followed by (cezar [a-z]+)/g)].map(match => match[1]!);
 expect(displayed).toEqual(['cezar tasks', 'cezar status', 'cezar reply', 'cezar cancel', 'cezar continue']);
 for (const command of displayed) {
  expect(await normalize('<@UREALBOT> ' + command)).toMatchObject({ kind: 'message', addressed: true, text: command.replace('cezar ', '/') });
 }
 const accessCommand = /followed by (cezar tasks)/.exec(access)![1]!;
 expect(await normalize('<@UREALBOT> ' + accessCommand)).toMatchObject({ kind: 'message', addressed: true, text: '/tasks' });
 // Selecting the installed bot in Slack's picker produces a native mention on the wire.
 for (const command of ['tasks', 'status abc123', 'reply abc123 yes', 'cancel abc123', 'continue abc123', 'help']) {
  expect(await normalize('<@UREALBOT> cezar ' + command)).toMatchObject({ kind: 'message', addressed: true, text: '/' + command });
 }
});

it('keeps private instructions directly usable and does not turn pasted text into a native mention', async () => {
 expect(slackPresentation.command('tasks')).toBe('cezar tasks');
 expect(chatAccessGrantedText(slackPresentation, 'private:TTEAM:UREALBOT:DDM', bot)).toBe('Access granted. Try cezar tasks to see this project’s tasks.');
 expect(await normalize(slackPresentation.command('tasks'), false)).toMatchObject({ kind: 'message', addressed: true, text: '/tasks' });
 for (const text of ['cezar tasks', '@bot cezar tasks', '&lt;@UREALBOT&gt; cezar tasks']) {
  expect(await normalize(text)).toMatchObject({ kind: 'message', addressed: false });
 }
});

it('neutralizes untrusted mentions even when they name the installed bot', () => {
 const attack = '<@UREALBOT> <!channel> @everyone &';
 expect(slackPresentation.formatText(attack, 4000, bot)).toBe('&lt;@\u200bUREALBOT&gt; &lt;!channel&gt; @\u200beveryone &amp;');
 const task = slackPresentation.taskReply({ id: 'id', title: attack, status: 'waiting', excerpt: attack, questions: [{ question: attack }] });
 expect(task).not.toContain('<@');
 expect(task).not.toContain('<!channel>');
 expect(task).not.toContain('@everyone');
});

it('normalizes discovery composed with a picker mention, while copied text alone stays unaddressed', async () => {
 const link = 'https://app.slack.com/client/TTEAM/UREALBOT?cezar_start=CODE';
 const command = slackDiscoveryCommand(link);
 expect(command).toBe('cezar start CODE');
 expect(await normalize(command)).toMatchObject({ kind: 'message', addressed: false });
 expect(await normalize('&lt;@UREALBOT&gt; ' + command)).toMatchObject({ kind: 'message', addressed: false });
 expect(await normalize('<@UREALBOT> ' + command)).toMatchObject({ kind: 'start', code: 'CODE' });
 expect(await normalize(slackDiscoveryCommand(link), false)).toMatchObject({ kind: 'start', code: 'CODE' });
});
