import {
  API_URL,
  ANALYZE_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  FRAME_TIMEOUT_MS,
  TURN_TIMEOUT_MS,
  UPLOAD_TIMEOUT_MS,
} from '../config';
import type {
  AssistantSession,
  FrameAck,
  TurnInput,
  TurnOut,
  CaptureOut,
  ClinicalEvent,
  ErrorBody,
  GatewayMetrics,
  StudyDocument,
  StudyFileUpload,
  Health,
  IngestResponse,
  Protocol,
  ProtocolCreate,
  Rejection,
  ValidationRules,
} from './types';

/** The server answered with a non-2xx status and (usually) an ErrorBody. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ErrorBody,
  ) {
    super(body.message || `HTTP ${status}`);
    this.name = 'ApiError';
  }
  get code(): string {
    return this.body.error;
  }
}

/** No answer: offline, server down, wrong API_URL, or the timeout fired. */
export class NetworkError extends Error {
  constructor(
    message: string,
    readonly timedOut: boolean,
  ) {
    super(message);
    this.name = 'NetworkError';
  }
}

type FetchLike = typeof fetch;
let fetchImpl: FetchLike = (...args) => fetch(...args);

/** Test seam. */
export function setFetch(impl: FetchLike): void {
  fetchImpl = impl;
}

export function absoluteUrl(path: string): string {
  return /^https?:\/\//.test(path) ? path : `${API_URL}${path}`;
}

async function request<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(absoluteUrl(path), {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const timedOut = controller.signal.aborted;
    throw new NetworkError(timedOut ? `Timed out after ${timeoutMs} ms` : String(err), timedOut);
  } finally {
    clearTimeout(timer);
  }
  let parsed: unknown = null;
  const text = await response.text();
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!response.ok) {
    const fallback: ErrorBody = { error: `http_${response.status}`, message: text.slice(0, 200) };
    throw new ApiError(response.status, (parsed as ErrorBody) ?? fallback);
  }
  return parsed as T;
}

export const api = {
  health: () => request<Health>('GET', '/health'),
  bloodPressurePreset: () => request<ValidationRules>('GET', '/presets/blood_pressure'),

  listProtocols: () => request<Protocol[]>('GET', '/protocols'),
  activeProtocol: () => request<Protocol>('GET', '/protocols/active'),
  createProtocol: (body: ProtocolCreate) => request<Protocol>('POST', '/protocols', body),
  activateProtocol: (id: string) => request<Protocol>('POST', `/protocols/${encodeURIComponent(id)}/activate`),
  deactivateProtocol: (id: string) =>
    request<Protocol>('POST', `/protocols/${encodeURIComponent(id)}/deactivate`),

  listEvents: (protocolId?: string) =>
    request<ClinicalEvent[]>('GET', `/events${protocolId ? `?protocol_id=${encodeURIComponent(protocolId)}` : ''}`),
  listRejections: (protocolId?: string) =>
    request<Rejection[]>(
      'GET',
      `/rejections${protocolId ? `?protocol_id=${encodeURIComponent(protocolId)}` : ''}`,
    ),
  gatewayMetrics: () => request<GatewayMetrics>('GET', '/metrics/gateway'),

  createCapture: (body: { protocol_id: string; patient_id: string; session_id: string; image_base64: string }) =>
    request<CaptureOut>('POST', '/captures', body, ANALYZE_TIMEOUT_MS),
  confirmCapture: (captureId: string, idempotencyKey: string) =>
    request<IngestResponse>('POST', `/captures/${encodeURIComponent(captureId)}/confirm`, {
      idempotency_key: idempotencyKey,
    }),
  discardCapture: (captureId: string) =>
    request<{ voice_line_id: string; voice_script: string }>(
      'POST',
      `/captures/${encodeURIComponent(captureId)}/discard`,
    ),

  // Study documents Gem reads (researcher portal)
  listDocuments: (protocolId: string) =>
    request<StudyDocument[]>('GET', `/protocols/${encodeURIComponent(protocolId)}/documents`),
  addNote: (protocolId: string, title: string, text: string) =>
    request<StudyDocument>('POST', `/protocols/${encodeURIComponent(protocolId)}/documents/notes`, { title, text }),
  addFile: (protocolId: string, file: StudyFileUpload) =>
    request<StudyDocument>('POST', `/protocols/${encodeURIComponent(protocolId)}/documents/files`, file, UPLOAD_TIMEOUT_MS),
  deleteDocument: (protocolId: string, docId: string) =>
    request<null>('DELETE', `/protocols/${encodeURIComponent(protocolId)}/documents/${encodeURIComponent(docId)}`),
  documentUrl: (protocolId: string, docId: string) =>
    absoluteUrl(`/protocols/${encodeURIComponent(protocolId)}/documents/${encodeURIComponent(docId)}/content`),

  // Gem assistant
  createSession: () => request<AssistantSession>('POST', '/sessions', {}),
  endSession: (id: string) => request<null>('DELETE', `/sessions/${encodeURIComponent(id)}`),
  sendFrame: (id: string, imageBase64: string) =>
    request<FrameAck>('POST', `/sessions/${encodeURIComponent(id)}/frames`, { image_base64: imageBase64 }, FRAME_TIMEOUT_MS),
  sendTurn: (id: string, input: TurnInput) =>
    request<TurnOut>('POST', `/sessions/${encodeURIComponent(id)}/turns`, input, TURN_TIMEOUT_MS),
};

/** The session is gone (timed out after 10 idle minutes, or the server restarted). */
export function isSessionGone(err: unknown): boolean {
  return err instanceof ApiError && (err.code === 'session_expired' || err.code === 'session_not_found');
}

export type Api = typeof api;
