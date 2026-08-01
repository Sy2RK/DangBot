import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HermesBackendClient } from '../src/services/hermes/hermesBackendClient.js';

const nativeTools = ['web_search', 'browser_navigate'];

describe('HermesBackendClient', () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          })
      )
    );
  });

  it('fails closed unless readiness, model, and the exact safe tool surface are present', async () => {
    const requested: string[] = [];
    const baseURL = await listen((request, response) => {
      requested.push(request.url ?? '');
      if (request.url === '/health/detailed') {
        return json(response, 200, { status: 'ok', readiness: { status: 'ok' } });
      }
      if (request.url === '/v1/models') {
        return json(response, 200, { data: [{ id: 'deepseek-v4-flash' }] });
      }
      if (request.url === '/v1/toolsets') {
        return json(response, 200, { data: [{ enabled: true, tools: nativeTools }] });
      }
      return json(response, 404, {});
    });
    await expect(makeClient(baseURL).assertReady()).resolves.toMatchObject({ status: 'ok' });
    expect(requested).toEqual(['/health/detailed', '/v1/models', '/v1/toolsets']);

    const degradedURL = await listen((request, response) => {
      if (request.url === '/health/detailed') {
        return json(response, 200, { status: 'degraded', readiness: { status: 'degraded' } });
      }
      return json(response, 404, {});
    });
    await expect(makeClient(degradedURL).assertReady()).rejects.toThrow(/readiness/iu);

    const identityRoot = await mkdtemp(path.join(os.tmpdir(), 'dangbot-hermes-identity-'));
    const identityFile = path.join(identityRoot, 'home', 'gateway.pid');
    await mkdir(path.dirname(identityFile), { recursive: true });
    await writeFile(identityFile, JSON.stringify({
      pid: 42,
      argv: [path.join(identityRoot, 'venv', 'bin', 'python')]
    }));
    const wrongIdentityURL = await listen((request, response) => {
      if (request.url === '/health/detailed') {
        return json(response, 200, { status: 'ok', readiness: { status: 'ok' }, pid: 43 });
      }
      return json(response, 404, {});
    });
    await expect(makeClient(wrongIdentityURL, identityFile).assertReady()).rejects.toThrow(
      /PID/iu
    );

    const missingToolURL = await listen((request, response) => {
      if (request.url === '/health/detailed') {
        return json(response, 200, { status: 'ok', readiness: { status: 'ok' } });
      }
      if (request.url === '/v1/models') {
        return json(response, 200, { data: [{ id: 'deepseek-v4-flash' }] });
      }
      if (request.url === '/v1/toolsets') {
        return json(response, 200, {
          data: [{ enabled: true, tools: nativeTools.filter((tool) => tool !== 'browser_navigate') }]
        });
      }
      return json(response, 404, {});
    });
    await expect(makeClient(missingToolURL).assertReady()).rejects.toThrow(
      /browser_navigate/iu
    );

    const unsafeToolURL = await listen((request, response) => {
      if (request.url === '/health/detailed') {
        return json(response, 200, { status: 'ok', readiness: { status: 'ok' } });
      }
      if (request.url === '/v1/models') {
        return json(response, 200, { data: [{ id: 'deepseek-v4-flash' }] });
      }
      if (request.url === '/v1/toolsets') {
        return json(response, 200, {
          data: [{ enabled: true, tools: [...nativeTools, 'terminal'] }]
        });
      }
      return json(response, 404, {});
    });
    await expect(makeClient(unsafeToolURL).assertReady()).rejects.toThrow(/terminal/iu);
  });

  it('starts a run, streams terminal events, and sends scoped session headers', async () => {
    let receivedBody: Record<string, unknown> | undefined;
    let sessionKey = '';
    const baseURL = await listen(async (request, response) => {
      if (request.url === '/v1/runs' && request.method === 'POST') {
        receivedBody = JSON.parse(await readBody(request)) as Record<string, unknown>;
        sessionKey = String(request.headers['x-hermes-session-key'] ?? '');
        json(response, 202, { run_id: 'run_test', status: 'started' });
        return;
      }
      if (request.url === '/v1/runs/run_test/events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write('data: {"event":"tool.started","tool":"web_search"}\n\n');
        response.end(
          'data: {"event":"run.completed","output":"完成","usage":{"total_tokens":12}}\n\n'
        );
        return;
      }
      json(response, 404, {});
    });
    const client = makeClient(baseURL);
    const identity = client.sessionIdentity('room-a', 'user-a');
    const events: string[] = [];
    const result = await client.run(
      {
        input: '测试',
        instructions: '安全指令',
        sessionId: identity.sessionId,
        sessionKey: identity.sessionKey,
        onEvent: (event) => {
          events.push(event.event);
        }
      },
      new AbortController().signal
    );

    expect(result.output).toBe('完成');
    expect(events).toEqual(['tool.started', 'run.completed']);
    expect(sessionKey).toBe(identity.sessionKey);
    expect(receivedBody).toMatchObject({
      input: '测试',
      instructions: '安全指令',
      session_id: identity.sessionId,
      model: 'deepseek-v4-flash'
    });
    expect(identity.sessionId).not.toContain('room-a');
    expect(identity.sessionKey).not.toContain('user-a');
    expect(identity.sessionId).toMatch(/^dangbot_i_[a-f0-9]{40}$/);
    expect(client.sessionIdentity('room-a', 'user-a', 0, 'reflection').sessionId).toMatch(
      /^dangbot_r_[a-f0-9]{40}$/
    );
    expect(client.sessionIdentity('room-a', 'user-b').sessionId).not.toBe(identity.sessionId);
    expect(client.sessionIdentity('room-b', 'user-a').sessionId).not.toBe(identity.sessionId);
  });

  it('falls back to pollable status when the SSE endpoint is unavailable', async () => {
    let polls = 0;
    const baseURL = await listen(async (request, response) => {
      if (request.url === '/v1/runs') return json(response, 202, { run_id: 'run_poll' });
      if (request.url === '/v1/runs/run_poll/events') return json(response, 503, {});
      if (request.url === '/v1/runs/run_poll') {
        polls += 1;
        return json(response, 200, {
          run_id: 'run_poll',
          status: polls > 1 ? 'completed' : 'running',
          output: polls > 1 ? '轮询完成' : undefined
        });
      }
      json(response, 404, {});
    });
    const client = makeClient(baseURL);
    const identity = client.sessionIdentity('room', 'user');
    const result = await client.run(
      {
        input: '测试',
        instructions: '指令',
        sessionId: identity.sessionId,
        sessionKey: identity.sessionKey
      },
      new AbortController().signal
    );
    expect(result.output).toBe('轮询完成');
    expect(polls).toBeGreaterThan(1);
  });

  it('recovers approval state through polling and maps approval and stop endpoints', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    let polls = 0;
    const baseURL = await listen(async (request, response) => {
      if (request.url === '/v1/runs') return json(response, 202, { run_id: 'run_approval' });
      if (request.url === '/v1/runs/run_approval/events') return json(response, 503, {});
      if (request.url === '/v1/runs/run_approval' && request.method === 'GET') {
        polls += 1;
        return json(response, 200, {
          run_id: 'run_approval',
          status: polls === 1 ? 'waiting_for_approval' : 'completed',
          output: polls > 1 ? '批准后完成' : undefined
        });
      }
      if (request.method === 'POST' && request.url?.endsWith('/approval')) {
        calls.push({ url: request.url, body: await readBody(request) });
        return json(response, 200, {});
      }
      if (request.method === 'POST' && request.url?.endsWith('/stop')) {
        calls.push({ url: request.url, body: await readBody(request) });
        return json(response, 200, {});
      }
      return json(response, 404, {});
    });
    const client = makeClient(baseURL);
    const identity = client.sessionIdentity('room', 'user');
    const events: string[] = [];
    const result = await client.run(
      {
        input: '测试',
        instructions: '指令',
        sessionId: identity.sessionId,
        sessionKey: identity.sessionKey,
        onEvent: (event) => {
          events.push(event.event);
        }
      },
      new AbortController().signal
    );
    await client.approveRun('run_approval', true);
    await client.stopRun('run_approval');

    expect(result.output).toBe('批准后完成');
    expect(events).toContain('approval.request');
    expect(calls).toEqual([
      {
        url: '/v1/runs/run_approval/approval',
        body: JSON.stringify({ choice: 'once', all: false })
      },
      { url: '/v1/runs/run_approval/stop', body: '{}' }
    ]);
  });

  it('stops the remote run when the request timeout fires', async () => {
    let stopped = false;
    const baseURL = await listen(async (request, response) => {
      if (request.url === '/v1/runs' && request.method === 'POST') {
        return json(response, 202, { run_id: 'run_timeout' });
      }
      if (request.url === '/v1/runs/run_timeout/events') return json(response, 503, {});
      if (request.url === '/v1/runs/run_timeout' && request.method === 'GET') {
        return json(response, 200, {
          run_id: 'run_timeout', status: stopped ? 'cancelled' : 'running'
        });
      }
      if (request.url === '/v1/runs/run_timeout/stop' && request.method === 'POST') {
        stopped = true;
        return json(response, 200, {});
      }
      return json(response, 404, {});
    });
    const client = new HermesBackendClient({
      baseURL,
      apiKey: 'api-test-key-long-enough',
      sessionSecret: 'stable-test-session-secret-at-least-32-characters',
      identityFile: '',
      model: 'deepseek-v4-flash',
      requestTimeoutMs: 40,
      pollIntervalMs: 10,
      maxConcurrentRuns: 2
    });
    const identity = client.sessionIdentity('room', 'user');
    await expect(
      client.run(
        {
          input: '测试',
          instructions: '指令',
          sessionId: identity.sessionId,
          sessionKey: identity.sessionKey
        },
        new AbortController().signal
      )
    ).rejects.toThrow();
    expect(stopped).toBe(true);
  });

  it('treats an already missing orphan run as safely stopped during restart reconciliation', async () => {
    const baseURL = await listen((request, response) => {
      if (request.url === '/v1/runs/run_missing/stop') return json(response, 404, {});
      return json(response, 500, {});
    });
    await expect(makeClient(baseURL).stopRunIfPresent('run_missing')).resolves.toBe('missing');
  });

  function makeClient(baseURL: string, identityFile = ''): HermesBackendClient {
    return new HermesBackendClient({
      baseURL,
      apiKey: 'api-test-key-long-enough',
      sessionSecret: 'stable-test-session-secret-at-least-32-characters',
      identityFile,
      model: 'deepseek-v4-flash',
      requestTimeoutMs: 2_000,
      pollIntervalMs: 10,
      maxConcurrentRuns: 2
    });
  }

  async function listen(
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  ): Promise<string> {
    const server = createServer((request, response) => void handler(request, response));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test server address');
    return `http://127.0.0.1:${address.port}`;
  }
});

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}
