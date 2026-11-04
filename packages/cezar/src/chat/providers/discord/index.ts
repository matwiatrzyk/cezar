import { ChatTransportError, type ChatProvider, type ChatServiceDescriptor, type ChatTransport } from '../../provider.ts';
import { discordCredentialFields, decodeDiscordCredentials, discordChatId, snowflake } from './identity.ts';
import { discordPresentation } from './presentation.ts';
import { discordRequest, type DiscordRequest } from './rest.ts';
import { discordSession } from './session.ts';
import { discordGateway, type DiscordSocketFactory } from './gateway.ts';
export { encodeDiscordCredentials, decodeDiscordCredentials, discordChatId } from './identity.ts';
export { discordPresentation, renderDiscordNotification } from './presentation.ts';
export const discordProvider: ChatProvider = {
 id: 'discord', label: 'Discord', credentials: discordCredentialFields,
 ids: { bot: snowflake, user: snowflake, message: snowflake, chat: discordChatId },
 limits: { maxText: 2000, buttonsPerMessage: 25, perChatPerSecond: 1, perBotPerSecond: 10 },
 renderText: discordPresentation.formatText, command: discordPresentation.command, discoveryLink: discordPresentation.discoveryLink,
};
export const discordServiceDescriptor: ChatServiceDescriptor = {
 ...discordProvider, format: 'discord.v1', presentation: discordPresentation,
 destination: credential => { decodeDiscordCredentials(credential); return 'https://discord.com/api/v10'; }, credentialBotId: () => undefined,
};
export interface DiscordTransportOptions { token: string | (() => Promise<string>); dryRun?: boolean; request?: DiscordRequest; socket?: DiscordSocketFactory }
export function discordTransport(input: DiscordTransportOptions, valid: () => boolean = () => true): ChatTransport {
 let boundToken: string | undefined;
 const resolveToken = async () => {
  if (input.dryRun && !input.request) throw new ChatTransportError({ kind: 'blocked' });
  let credential: string;
  try { credential = typeof input.token === 'string' ? input.token : await input.token(); }
  catch (error) {
   if (error instanceof ChatTransportError) throw error;
   throw new ChatTransportError({ kind: 'blocked' });
  }
  let token: string; try { token = decodeDiscordCredentials(credential); } catch { throw new ChatTransportError({ kind: 'auth' }); }
  if (boundToken !== undefined && boundToken !== token) throw new ChatTransportError({ kind: 'auth' });
  boundToken = token; return token;
 };
 const wire = input.request ?? discordRequest(resolveToken, valid);
 const request: DiscordRequest = async (method, path, body, signal, authorization) => {
  if (input.request) await resolveToken();
  if (!valid() || authorization?.() === false || signal?.aborted) { throw new ChatTransportError({ kind: 'blocked' }); }
  return wire(method, path, body, signal, () => valid() && (authorization?.() ?? true));
 };
 return { ...discordSession(request), guarded(check) { return discordTransport(input, () => valid() && check()); },
  connect(_journal, options, now) { return discordGateway({ token: resolveToken, request, options, valid: () => valid() && (!input.dryRun || !!input.socket), ...(input.socket ? { socket: input.socket } : {}), ...(now ? { now } : {}) }); },
 };
}
