import crypto from 'node:crypto';
import { AuthContext, Command, OfflineTicket, User } from './types.js';
import { DomainError } from './domain.js';

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

export function hmac(secret: string, payload: unknown) {
  return crypto.createHmac('sha256', secret).update(stableStringify(payload)).digest('hex');
}

export function timingEqual(a: string, b: string) {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function authenticate(users: User[], token?: string): AuthContext {
  const user = users.find((u) => u.token === token);
  if (!user) throw new DomainError('UNAUTHORIZED', '缺少有效账号令牌', 401);
  return { userId: user.id, name: user.name, roles: user.roles };
}

export interface OfflineEnvelope<T> {
  clientItemId: string;
  command: T;
  signature: string;
}

export async function verifyOfflineCommand(
  users: User[],
  findTicket: (id: string) => Promise<OfflineTicket | undefined>,
  envelope: OfflineEnvelope<Command>,
  syncActor: AuthContext,
  now = new Date()
): Promise<{ actor: AuthContext; command: Command }> {
  const c = envelope.command as Command;
  if (!('ticketId' in c) || typeof (c as { ticketId?: unknown }).ticketId !== 'string') {
    throw new DomainError('NO_OFFLINE_TICKET', '离线事实必须包含在线签发的票券；两次本地点击不能构成授权。', 401);
  }
  if (c.type !== 'inoculation.confirm') throw new DomainError('TICKET_SCOPE_DENIED', '离线票券仅可用于接种确认事实。', 403);
  const ticket = await findTicket(c.ticketId);
  if (!ticket) throw new DomainError('TICKET_UNKNOWN', '票券不存在，可能从未在线签发或已删除。', 401);
  if (ticket.userId !== syncActor.userId) throw new DomainError('TICKET_USER_MISMATCH', '票券不属于当前同步账号，不能代传他人离线签名。', 403);
  if (ticket.revoked) throw new DomainError('TICKET_REVOKED', '离线票券已撤销。', 401);
  if (new Date(ticket.expiresAt).getTime() < now.getTime()) throw new DomainError('TICKET_EXPIRED', '离线票券已过期，请重新联网授权。', 401);
  const expected = hmac(ticket.secret, { clientItemId: envelope.clientItemId, command: c });
  if (!timingEqual(expected, envelope.signature ?? '')) throw new DomainError('BAD_SIGNATURE', '离线签名不匹配。', 401);
  const user = users.find((u) => u.id === ticket.userId);
  if (!user) throw new DomainError('USER_DISABLED', '票券账号已不存在或禁用。', 401);
  return { actor: { userId: user.id, name: user.name, roles: user.roles }, command: c };
}

export function randomTicketId() { return crypto.randomUUID(); }
export function randomSecret() { return crypto.randomBytes(32).toString('hex'); }
