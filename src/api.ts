import { idbGet, idbSet } from './db/idb';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}

export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await idbGet<string>('token');
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  if (token) headers.set('authorization', `Bearer ${token}`);
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers });
  } catch (e) {
    throw new ApiError(0, 'OFFLINE', '当前无法连接在线授权服务，可先离线采集事实');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? 'ERROR', body.message ?? '请求失败', body.details);
  return body as T;
}

export async function login(loginName: string, password: string) {
  const data = await api<{ token: string; user: any }>('/auth/login', { method: 'POST', body: JSON.stringify({ login: loginName, password }) });
  await idbSet('token', data.token);
  await idbSet('user', data.user);
  return data.user;
}

export async function logout() {
  await idbSet('token', '');
  await idbSet('user', null);
}
