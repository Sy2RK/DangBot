import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { HermesBackendClient } from '../src/services/hermes/hermesBackendClient.js';

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

  function makeClient(baseURL: string): HermesBackendClient {
    return new HermesBackendClient({
      baseURL,
      apiKey: 'api-test-key-long-enough',
      sessionSecret: 'stable-test-session-secret-at-least-32-characters',
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
