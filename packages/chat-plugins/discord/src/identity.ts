import { z } from 'zod'
export const snowflake = z.string().regex(/^\d{17,20}$/)
export const channelSchema = z.object({ id: snowflake, type: z.number().int(), guild_id: snowflake.optional(), recipients: z.array(z.object({ id: snowflake })).optional() })
export function parseChat(id: string) { const p = id.split(':'); if (p[0] !== 'discord' || (p[1] !== 'dm' && p[1] !== 'guild') || !snowflake.safeParse(p[p.length - 1]).success) throw new Error('invalid chat'); return p[1] === 'dm' ? { id, kind: 'private' as const, channel: p[2]! } : { id, kind: 'group' as const, guild: p[2]!, channel: p[3]! } }
export function channelIdentity(value: unknown) { const c = channelSchema.parse(value); if (c.type === 1 && !c.guild_id) return { id: `discord:dm:${c.id}`, kind: 'private' as const, channel: c }; if (c.type === 0 && c.guild_id) return { id: `discord:guild:${c.guild_id}:${c.id}`, kind: 'group' as const, channel: c }; throw new Error('unsupported channel') }
