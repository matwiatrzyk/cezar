import { afterEach, describe, expect, it, vi } from 'vitest';
const wire = vi.hoisted(() => ({ request: vi.fn(), destroy: vi.fn(async () => undefined) }));
vi.mock('undici', () => ({ Agent: class { destroy = wire.destroy; }, request: wire.request }));
import { telegramConnect, TelegramConnectError } from './telegram-connect.ts';

const token = `123456789:${'T'.repeat(35)}`;
const code = 'AbCdEf234567';
const options = { policy: { mode: 'local' as const, allowLocalNetwork: false, serverPorts: [4317] }, lookup: async () => [{ address: '149.154.167.220', family: 4 }] };
const reply = (value: unknown, statusCode = 200) => ({ statusCode, headers: {}, body: Object.assign((async function* () { yield Buffer.from(JSON.stringify(value)); })(), { destroy: () => undefined }) });
const me = () => reply({ ok: true, result: { id: 123456789, is_bot: true, first_name: 'Cezar alerts', username: 'cezar_alerts_bot' } });
function telegram(updates: unknown[] | ReturnType<typeof reply>) {
  wire.request.mockImplementation(async (url: URL) => url.pathname.endsWith('/getMe') ? me() : Array.isArray(updates) ? reply({ ok: true, result: updates }) : updates);
}
const message = (chat: object, text?: string) => ({ update_id: 1, message: { message_id: 1, date: 0, chat, ...(text ? { text } : {}) } });
afterEach(() => { vi.clearAllMocks(); });

describe('Telegram chat connection', () => {
  it('matches the start link in a private chat and reads updates without consuming them', async () => {
    telegram([message({ id: 42, type: 'private', first_name: 'Ada', last_name: 'L' }, `/start ${code}`)]);
    const result = await telegramConnect({ token, code }, options);
    expect(result).toEqual({ bot: { username: 'cezar_alerts_bot', name: 'Cezar alerts' }, chats: [{ id: '42', type: 'private', title: 'Ada L' }], match: { id: '42', type: 'private', title: 'Ada L' } });
    const [url, init] = wire.request.mock.calls[1]!;
    expect(String(url)).toBe(`https://api.telegram.org/bot${token}/getUpdates`);
    // No offset (would consume updates) and no allowed_updates (Telegram remembers it for the bot).
    expect(JSON.parse(init.body)).toEqual({ limit: 100, timeout: 0 });
    expect(init.maxRedirections).toBe(0);
  });
  it('matches a group start command addressed to the bot, and a bare code posted in a channel', async () => {
    telegram([message({ id: -1001, type: 'supergroup', title: 'Ops' }, `/start@Cezar_Alerts_Bot ${code}`)]);
    expect((await telegramConnect({ token, code }, options)).match).toEqual({ id: '-1001', type: 'supergroup', title: 'Ops' });
    telegram([{ update_id: 2, channel_post: { chat: { id: -1002, type: 'channel', title: 'Alerts' }, text: ` ${code} ` } }]);
    expect((await telegramConnect({ token, code }, options)).match).toEqual({ id: '-1002', type: 'channel', title: 'Alerts' });
  });
  it('ignores other codes and commands for other bots, but lists known chats newest first', async () => {
    telegram([
      message({ id: 1, type: 'group', title: 'Old' }, `/start other1234567`),
      { update_id: 2, my_chat_member: { chat: { id: -1003, type: 'channel', title: 'Joined' } } },
      message({ id: 2, type: 'group', title: 'Elsewhere' }, `/start@another_bot ${code}`),
      message({ id: 1, type: 'group', title: 'Old' }, 'hello'),
      { update_id: 9, message: { chat: { id: 'x', type: 'group' } } },
    ]);
    const result = await telegramConnect({ token, code }, options);
    expect(result.match).toBeUndefined();
    expect(result.chats.map(chat => chat.id)).toEqual(['1', '2', '-1003']);
  });
  it('keeps only chat identities from updates', async () => {
    telegram([message({ id: 42, type: 'private', username: 'ada' }, `secret message ${token}`)]);
    const result = await telegramConnect({ token, code }, options);
    expect(JSON.stringify(result)).not.toContain('secret message');
    expect(result.chats).toEqual([{ id: '42', type: 'private', title: '@ada' }]);
  });
  it('reports a full update page instead of pretending discovery is complete', async () => {
    telegram(Array.from({ length: 100 }, (_, index) => message({ id: index + 1, type: 'group', title: `Chat ${index}` }, 'old')));
    expect((await telegramConnect({ token, code }, options)).truncated).toBe(true);
  });
  it.each([
    [reply({ ok: false, error_code: 401, description: 'Unauthorized' }, 401), 400, 'rejected this bot token', 'getMe'],
    [reply({ ok: false, error_code: 409, description: 'Conflict: can\'t use getUpdates method while webhook is active' }, 409), 409, 'another app or webhook', 'getUpdates'],
    [reply({ ok: false }, 500), 502, 'Could not reach Telegram', 'getUpdates'],
  ] as const)('maps provider failures to fixed messages (%#)', async (failure, status, message, method) => {
    wire.request.mockImplementation(async (url: URL) => url.pathname.endsWith(`/${method}`) ? failure : me());
    const error = await telegramConnect({ token, code }, options).catch(error => error);
    expect(error).toBeInstanceOf(TelegramConnectError);
    expect(error).toMatchObject({ status });
    expect(error.message).toContain(message);
    expect(error.message).not.toContain(token);
  });
  it('never echoes a transport error, which could name the token-bearing URL', async () => {
    wire.request.mockRejectedValue(new Error(`connect failed https://api.telegram.org/bot${token}/getMe`));
    const error = await telegramConnect({ token, code }, options).catch(error => error);
    expect(error).toMatchObject({ status: 502 });
    expect(error.message).not.toContain(token);
  });
  it('refuses a destination the server policy denies', async () => {
    const error = await telegramConnect({ token, code }, { ...options, lookup: async () => [{ address: '10.0.0.1', family: 4 }] }).catch(error => error);
    expect(error).toMatchObject({ status: 409 });
    expect(wire.request).not.toHaveBeenCalled();
  });
  it('sends nothing under dry-run', async () => {
    expect((await telegramConnect({ token, code }, { ...options, dryRun: true })).match).toMatchObject({ type: 'group' });
    expect(wire.request).not.toHaveBeenCalled();
  });
});
