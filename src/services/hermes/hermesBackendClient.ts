import { createHash, createHmac } from 'node:crypto';
import type { AppConfig, HermesRunStatus } from '../../types.js';
import { redactSensitiveText } from '../../utils/redaction.js';

export interface HermesRunEvent {
  event:
    | 'message.delta'
    | 'tool.started'
    | 'tool.completed'
    | 'reasoning.available'
    | 'approval.request'
    | 'approval.responded'
    | 'run.completed'
    | 'run.failed'
    | 'run.cancelled'
    | string;
  run_id?: string;
  delta?: string;
  tool?: string;
  output?: string;
  error?: string;
  choices?: string[];
  [key: string]: unknown;
}

export interface HermesRunResult {
  runId: string;
  sessionId: string;
  output: string;
  status: Extract<HermesRunStatus, 'completed' | 'failed' | 'cancelled'>;
  usage?: Record<string, number>;
}

export interface HermesRunInput {
  input: string;
  instructions: string;
  sessionId: string;
  sessionKey: string;
  model?: string;
  onStarted?(runId: string): void | Promise<void>;
  onEvent?(event: HermesRunEvent): void | Promise<void>;
}

interface HermesRunStatusResponse {
  run_id: string;
  status: HermesRunStatus;
  output?: string;
  error?: string;
  usage?: Record<string, number>;
}

export class HermesBackendClient {
  private activeRuns = 0;

  constructor(private readonly config: AppConfig['agent']['hermes']) {}

  configured(): boolean {
    return Boolean(
      this.config.apiKey.trim().length >= 16 &&
      this.config.sessionSecret.trim().length >= 32 &&
      isLoopbackUrl(this.config.baseURL)
    );
  }

  sessionIdentity(
    roomId: string,
    userId: string,
    epoch = 0,
    purpose: 'interactive' | 'reflection' = 'interactive'
  ): {
    sessionId: string;
    sessionKey: string;
    sessionKeyHash: string;
  } {
    if (!this.config.sessionSecret) {
      throw new Error('Hermes 会话密钥未配置。');
    }
    const digest = createHmac('sha256', this.config.sessionSecret)
      .update(`${roomId}\u0000${userId}\u0000${epoch}\u0000${purpose}`)
      .digest('hex');
    const sessionKey = `dangbot:${digest}`;
    return {
      sessionId: `dangbot_${purpose === 'reflection' ? 'r' : 'i'}_${digest.slice(0, 40)}`,
      sessionKey,
      sessionKeyHash: sha256(sessionKey)
    };
  }

  async health(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestJson<Record<string, unknown>>('/health/detailed', { method: 'GET' }, signal);
  }

  async run(input: HermesRunInput, signal: AbortSignal): Promise<HermesRunResult> {
    if (!this.configured()) {
      throw new Error('Hermes 后端尚未配置 API 密钥或会话密钥。');
    }
    if (this.activeRuns >= this.config.maxConcurrentRuns) {
      throw new Error('Hermes 后端并发已满，请稍后再试。');
    }

    this.activeRuns += 1;
    let runId: string | undefined;
    const timeout = createTimeoutSignal(this.config.requestTimeoutMs, signal);
    try {
      const started = await this.requestJson<{ run_id: string; status: string }>(
        '/v1/runs',
        {
          method: 'POST',
          headers: this.sessionHeaders(input.sessionKey),
          body: JSON.stringify({
            input: input.input,
            instructions: input.instructions,
            session_id: input.sessionId,
            model: input.model ?? this.config.model
          })
        },
        timeout.signal
      );
      runId = started.run_id;
      if (!runId) throw new Error('Hermes 没有返回 run_id。');
      await input.onStarted?.(runId);

      const abortHandler = () => void this.stopRun(runId!).catch(() => undefined);
      timeout.signal.addEventListener('abort', abortHandler, { once: true });
      try {
        const streamed = await this.consumeEvents(runId, input.onEvent, timeout.signal).catch(
          (error: unknown) => {
            if (signal.aborted || timeout.signal.aborted) throw error;
            return undefined;
          }
        );
        if (streamed) return toRunResult(runId, input.sessionId, streamed);

        const polled = await this.pollRun(runId, input.onEvent, timeout.signal);
        return toRunResult(runId, input.sessionId, polled);
      } finally {
        timeout.signal.removeEventListener('abort', abortHandler);
      }
    } finally {
      timeout.dispose();
      this.activeRuns -= 1;
    }
  }

  async approveRun(runId: string, approved: boolean): Promise<void> {
    await this.requestJson(`/v1/runs/${encodeURIComponent(runId)}/approval`, {
      method: 'POST',
      body: JSON.stringify({ choice: approved ? 'once' : 'deny', all: false })
    });
  }

  async stopRun(runId: string): Promise<void> {
    await this.requestJson(`/v1/runs/${encodeURIComponent(runId)}/stop`, {
      method: 'POST',
      body: '{}'
    });
  }

  private async consumeEvents(
    runId: string,
    onEvent: HermesRunInput['onEvent'],
    signal: AbortSignal
  ): Promise<HermesRunStatusResponse | undefined> {
    const response = await fetch(this.url(`/v1/runs/${encodeURIComponent(runId)}/events`), {
      method: 'GET',
      headers: this.authHeaders(),
      signal
    });
    if (!response.ok || !response.body) {
      throw new Error(`Hermes 事件流不可用（HTTP ${response.status}）。`);
    }

    let terminal: HermesRunStatusResponse | undefined;
    for await (const event of parseSseEvents(response.body)) {
      await onEvent?.(event);
      if (event.event === 'run.completed') {
        terminal = {
          run_id: runId,
          status: 'completed',
          output: typeof event.output === 'string' ? event.output : '',
          usage: isNumberRecord(event.usage) ? event.usage : undefined
        };
      } else if (event.event === 'run.failed') {
        terminal = {
          run_id: runId,
          status: 'failed',
          error: typeof event.error === 'string' ? event.error : 'Hermes 运行失败。'
        };
      } else if (event.event === 'run.cancelled') {
        terminal = { run_id: runId, status: 'cancelled' };
      }
    }
    return terminal;
  }

  private async pollRun(
    runId: string,
    onEvent: HermesRunInput['onEvent'],
    signal: AbortSignal
  ): Promise<HermesRunStatusResponse> {
    let previousStatus: HermesRunStatus | undefined;
    while (!signal.aborted) {
      const status = await this.requestJson<HermesRunStatusResponse>(
        `/v1/runs/${encodeURIComponent(runId)}`,
        { method: 'GET' },
        signal
      );
      if (status.status !== previousStatus) {
        await onEvent?.(
          status.status === 'waiting_for_approval'
            ? { event: 'approval.request', run_id: runId, recoveredByPolling: true }
            : { event: `run.status.${status.status}`, run_id: runId, status: status.status }
        );
        previousStatus = status.status;
      }
      if (['completed', 'failed', 'cancelled'].includes(status.status)) return status;
      await delay(this.config.pollIntervalMs, signal);
    }
    throw abortError();
  }

  private async requestJson<T = Record<string, unknown>>(
    pathname: string,
    init: RequestInit,
    signal?: AbortSignal
  ): Promise<T> {
    const response = await fetch(this.url(pathname), {
      ...init,
      headers: {
        ...this.authHeaders(),
        'Content-Type': 'application/json',
        ...(init.headers ?? {})
      },
      signal
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Hermes 请求失败（HTTP ${response.status}）：${safeErrorPreview(text)}`);
    }
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error('Hermes 返回了无效 JSON。');
    }
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.config.apiKey}` };
  }

  private sessionHeaders(sessionKey: string): Record<string, string> {
    return { ...this.authHeaders(), 'X-Hermes-Session-Key': sessionKey };
  }

  private url(pathname: string): string {
    return new URL(pathname, `${this.config.baseURL.replace(/\/$/, '')}/`).toString();
  }
}

export async function* parseSseEvents(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<HermesRunEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replaceAll('\r\n', '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) {
          try {
            const parsed = JSON.parse(data) as HermesRunEvent;
            if (parsed && typeof parsed.event === 'string') yield parsed;
          } catch {
            // Ignore malformed transport frames and rely on status polling.
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

function toRunResult(
  runId: string,
  sessionId: string,
  status: HermesRunStatusResponse
): HermesRunResult {
  if (status.status === 'failed') throw new Error(status.error || 'Hermes 运行失败。');
  if (status.status === 'cancelled') throw abortError();
  if (status.status !== 'completed') throw new Error(`Hermes 返回了非终态：${status.status}`);
  return {
    runId,
    sessionId,
    output: status.output ?? '',
    status: 'completed',
    usage: status.usage
  };
}

function createTimeoutSignal(
  timeoutMs: number,
  parent: AbortSignal
): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent.reason);
  parent.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Hermes 请求超时。')), timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent.removeEventListener('abort', onAbort);
    }
  };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(): Error {
  return new Error('任务已取消。');
}

function safeErrorPreview(text: string): string {
  const compact = text
    .replace(/\s+/g, ' ')
    .trim();
  return redactSensitiveText(compact, 300) || '无错误详情';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return Boolean(
    value &&
    typeof value === 'object' &&
    Object.values(value).every((entry) => typeof entry === 'number')
  );
}

function isLoopbackUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname;
    return hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost';
  } catch {
    return false;
  }
}
