export type TelegramUnavailableReason = 'hosted' | 'webhooks_off' | 'flag_off';

/** The one gate for every Telegram inbound surface, reads included: hosted or flag-off answers empty. */
export function telegramUnavailableReason(mode: 'local' | 'hosted', env: NodeJS.ProcessEnv = process.env): TelegramUnavailableReason | undefined {
  return mode !== 'local' ? 'hosted' : env.CEZ_WEBHOOKS !== '1' ? 'webhooks_off' : env.CEZ_CHAT_INBOUND !== '1' ? 'flag_off' : undefined;
}
