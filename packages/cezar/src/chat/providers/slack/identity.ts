import { z } from 'zod';
import { encodeChatCredentials, decodeChatCredentials } from '../../credentials.ts';
export const slackCredentials = [
 { name: 'appToken', label: 'App-level token', pattern: /^xapp-[A-Za-z0-9-]{10,2000}$/ },
 { name: 'botToken', label: 'Bot token', pattern: /^xoxb-[A-Za-z0-9-]{10,2000}$/ },
] as const;
export const slackIds = {
 bot: z.string().regex(/^T[A-Z0-9]+:U[A-Z0-9]+$/),
 user: z.string().regex(/^[UW][A-Z0-9]+$/),
 chat: z.string().regex(/^(private|group):T[A-Z0-9]+:U[A-Z0-9]+:[CDG][A-Z0-9]+$/),
 message: z.string().regex(/^\d{10,16}\.\d{6}$/),
};
export const encodeSlackCredentials = (values: Record<string, string>) => encodeChatCredentials(slackCredentials, values);
export const decodeSlackCredentials = (value: string) => decodeChatCredentials(slackCredentials, value) as { appToken: string; botToken: string };
export function slackChat(id: string) {
 slackIds.chat.parse(id);
 const [kind, team, bot, channel] = id.split(':') as ['private' | 'group', string, string, string];
 return { kind, team, bot, channel, botId: `${team}:${bot}` };
}
