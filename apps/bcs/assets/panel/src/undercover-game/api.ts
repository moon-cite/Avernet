import type {
  PendingHumanNode,
  SessionMessage,
  StateMachineNodeDetailResponse,
  StateMachineRunGraph,
} from './types';

export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

export function unwrapEnvelope<T>(body: unknown): T {
  if (
    body && typeof body === 'object' && !Array.isArray(body) &&
    ('code' in body || 'request_id' in body) && 'data' in body
  ) {
    return (body as { data: T }).data;
  }
  return body as T;
}

export class ApiRequestError extends Error {
  readonly status?: number;
  readonly retryable: boolean;
  readonly conflict: boolean;

  constructor(message: string, options: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = options.status;
    this.retryable = options.retryable ?? Boolean(!options.status || options.status >= 500);
    this.conflict = options.status === 404 || options.status === 408 || options.status === 409 || options.status === 410 || options.status === 422;
  }
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return text; }
}

function errorMessage(body: unknown, status: number): string {
  if (typeof body === 'string' && body.trim()) return body.trim();
  if (body && typeof body === 'object') {
    const value = body as Record<string, unknown>;
    if (typeof value.message === 'string' && value.message.trim()) return value.message;
    if (value.data && typeof value.data === 'object' && typeof (value.data as Record<string, unknown>).message === 'string') {
      return String((value.data as Record<string, unknown>).message);
    }
  }
  return `BCS request failed (${status}).`;
}

export async function requestJson<T>(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(joinUrl(baseUrl, path), { credentials: 'include', ...init });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new ApiRequestError(error instanceof Error ? error.message : 'Network request failed.');
  }
  const body = await parseBody(response);
  if (!response.ok) {
    throw new ApiRequestError(errorMessage(body, response.status), { status: response.status });
  }
  if (typeof body === 'string') {
    throw new ApiRequestError('游戏接口未返回 JSON，请检查副屏 API 地址及反向代理配置。', { status: response.status });
  }
  return unwrapEnvelope<T>(body);
}

export function fetchRunGraph(baseUrl: string, runId: string, signal?: AbortSignal, fetchImpl?: typeof fetch) {
  return requestJson<StateMachineRunGraph>(baseUrl, `/state-machine-runs/${encodeURIComponent(runId)}/graph`, { signal }, fetchImpl);
}

export function fetchPendingHumanNodes(baseUrl: string, runId: string, signal?: AbortSignal, fetchImpl?: typeof fetch) {
  return requestJson<PendingHumanNode[]>(baseUrl, `/state-machine-runs/${encodeURIComponent(runId)}/pending-human-nodes`, { signal }, fetchImpl);
}

export function fetchNodeDetail(baseUrl: string, runId: string, nodeId: string, signal?: AbortSignal, fetchImpl?: typeof fetch) {
  return requestJson<StateMachineNodeDetailResponse>(baseUrl, `/state-machine-runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}`, { signal }, fetchImpl);
}

export function fetchSessionMessages(baseUrl: string, sessionId: string, signal?: AbortSignal, fetchImpl?: typeof fetch) {
  return requestJson<SessionMessage[]>(baseUrl, `/sessions/${encodeURIComponent(sessionId)}/messages?include_pending=true`, { signal }, fetchImpl);
}

export function respondToHumanNode(
  baseUrl: string,
  runId: string,
  nodeId: string,
  content: string,
  signal?: AbortSignal,
  fetchImpl?: typeof fetch,
) {
  return requestJson<unknown>(baseUrl, `/state-machine-runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/respond`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
    signal,
  }, fetchImpl);
}

/** Actor identity is resolved from the actual authenticated browser request. */
export async function fetchCurrentHumanActorId(baseUrl: string, signal?: AbortSignal): Promise<string> {
  const response = await requestJson<{ actor_uuid?: string | null }>(baseUrl, '/me', { signal });
  if (!response?.actor_uuid || !/^human_[A-Za-z0-9]+$/.test(response.actor_uuid)) {
    throw new ApiRequestError('BCS 未提供有效的人类登录身份。');
  }
  return response.actor_uuid;
}

/** Scope is a preference for UI projection, not a security authorization boundary. */
export async function fetchCurrentHumanScope(baseUrl: string, sessionId: string, actorId: string, signal?: AbortSignal): Promise<'participant' | 'full'> {
  const session = await requestJson<{ participants?: Array<{ bot_uuid?: string; message_view_scope?: string }> }>(
    baseUrl, `/sessions/${encodeURIComponent(sessionId)}`, { signal },
  );
  const mine = session?.participants?.find((member) => member.bot_uuid === actorId);
  if (!mine) throw new ApiRequestError('当前身份不在此会话中。');
  return mine.message_view_scope === 'participant' ? 'participant' : 'full';
}

/** Private word content is returned only when BCS authenticates the requesting actor
 * as a member of the Group Context entry's visible_to list. The random entry
 * name from public metadata is not itself an access token. */
export async function fetchPrivateHumanWord(
  baseUrl: string, groupId: string, sessionId: string, entryName: string, signal?: AbortSignal,
): Promise<string> {
  const query = new URLSearchParams({ groupId, sessionId });
  const result = await requestJson<{ status: string; items?: Array<{ content?: string }> }>(
    baseUrl, `/groupcontext/get?${query.toString()}`,
    { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: entryName, scope_levels: ['session'], limit: 1 }), signal },
  );
  const word = result?.items?.[0]?.content;
  if (!word || typeof word !== 'string') throw new ApiRequestError('私有词不可读取，已阻止不安全的发言。');
  return word;
}
