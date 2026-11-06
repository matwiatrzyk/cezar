import { z } from 'zod';
import { snowflake } from './identity.ts';
import type { DiscordRequest } from './rest.ts';
const permissions = z.string().regex(/^[0-9]{1,30}$/);
const memberSchema = z.object({ user: z.object({ id: snowflake }), roles: z.array(snowflake) });
const roleSchema = z.object({ id: snowflake, permissions });
const channelSchema = z.object({ id: snowflake, guild_id: snowflake, type: z.literal(0), permission_overwrites: z.array(z.object({ id: snowflake, type: z.union([z.literal(0), z.literal(1)]), allow: permissions, deny: permissions })) });
/** Guild membership alone does not establish access to a private guild channel. */
export async function discordChannelMember(request: DiscordRequest, channelId: string, guildId: string, userId: string, signal?: AbortSignal): Promise<boolean | undefined> {
 const member = memberSchema.safeParse(await request('GET', `/guilds/${guildId}/members/${userId}`, undefined, signal));
 if (!member.success || member.data.user.id !== userId) return;
 const channel = channelSchema.safeParse(await request('GET', `/channels/${channelId}`, undefined, signal));
 if (!channel.success || channel.data.id !== channelId || channel.data.guild_id !== guildId) return;
 const guild = z.object({ id: snowflake, owner_id: snowflake }).safeParse(await request('GET', `/guilds/${guildId}`, undefined, signal));
 if (!guild.success || guild.data.id !== guildId) return;
 if (guild.data.owner_id === userId) return true;
 const roles = z.array(roleSchema).safeParse(await request('GET', `/guilds/${guildId}/roles`, undefined, signal));
 if (!roles.success || !roles.data.some(role => role.id === guildId) || member.data.roles.some(id => !roles.data.some(role => role.id === id))) return;
 let allowed = roles.data.filter(role => role.id === guildId || member.data.roles.includes(role.id)).reduce((bits, role) => bits | BigInt(role.permissions), 0n);
 if (allowed & 8n) return true;
 const overrides = channel.data.permission_overwrites;
 const everyone = overrides.find(row => row.type === 0 && row.id === guildId);
 if (everyone) allowed = (allowed & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
 const assigned = overrides.filter(row => row.type === 0 && member.data.roles.includes(row.id));
 allowed = (allowed & ~assigned.reduce((bits, row) => bits | BigInt(row.deny), 0n)) | assigned.reduce((bits, row) => bits | BigInt(row.allow), 0n);
 const personal = overrides.find(row => row.type === 1 && row.id === userId);
 if (personal) allowed = (allowed & ~BigInt(personal.deny)) | BigInt(personal.allow);
 return (allowed & 1024n) !== 0n;
}
