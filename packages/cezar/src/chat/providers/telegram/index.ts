import { chatIdentifierSchemas } from '@open-mercato/cezar-contract';
import type { ChatProvider } from '../../provider.ts';
import { telegramPresentation } from './presentation.ts';
export const telegramProvider: ChatProvider = {
  id: 'telegram', label: 'Telegram',
  credentials: [{ name: 'token', label: 'Bot token', pattern: /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/ }],
  limits: { maxText: 4096, buttonsPerMessage: 100, perChatPerSecond: 1, perBotPerSecond: 10 },
  ids: chatIdentifierSchemas.telegram,
  renderText: telegramPresentation.formatText, command: telegramPresentation.command, discoveryLink: telegramPresentation.discoveryLink,
};
