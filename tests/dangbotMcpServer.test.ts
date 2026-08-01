import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import { ArtifactBroker } from '../src/services/artifacts/artifactBroker.js';
import { FileService } from '../src/services/files/fileService.js';
import { DashScopeMediaClient } from '../src/services/llm/dashScopeClient.js';
import { DangBotMcpServer } from '../src/services/mcp/dangbotMcpServer.js';
import { PortableCodeSandbox } from '../src/services/sandbox/portableCodeSandbox.js';
import { AppDatabase } from '../src/storage/database.js';
import { makeTestConfig, silentLogger } from './helpers.js';

describe('DangBot first-class MCP', () => {
  it('has no generic execution entry and enforces attachment/capability isolation', async () => {
    const fixture = await createFixture();
    const { server, client, transport, capability, db, allowedPath } = fixture;
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      expect(names).toContain('dangbot_file_extract');
      expect(names).toContain('dangbot_image_generate');
      expect(names).toContain('dangbot_automation_create');
      expect(names).toEqual(
        expect.arrayContaining([
          'dangbot_memory_recall',
          'dangbot_memory_propose',
          'dangbot_memory_feedback'
        ])
      );
      expect(names).not.toContain('dangbot_execute_tool');
      expect(names).not.toContain('dangbot_capabilities');

      const listed = payload(await client.callTool({
        name: 'dangbot_attachment_list', arguments: { contextId: capability.token }
      }));
      expect(JSON.stringify(listed)).toContain('allowed.txt');
      expect(JSON.stringify(listed)).not.toContain('foreign.txt');
      expect(JSON.stringify(listed)).not.toContain(allowedPath);

      const extracted = payload(await client.callTool({
        name: 'dangbot_file_extract',
        arguments: { contextId: capability.token, attachmentId: 'att_allowed1234', cursor: 2, maxChars: 500 }
      }));
      expect(extracted).toMatchObject({ status: 'ok', data: { cursor: 2, done: true, text: 'cdef' } });

      const javascript = payload(await client.callTool({
        name: 'dangbot_javascript_execute', arguments: { contextId: capability.token, code: 'return 6 * 7;' }
      }));
      expect(javascript).toMatchObject({ status: 'ok', data: { value: 42 } });

      const forged = await client.callTool({
        name: 'dangbot_attachment_list', arguments: { contextId: `${capability.token}x` }
      });
      expect(forged.isError).toBe(true);
      expect(payload(forged)).toMatchObject({ status: 'error', data: { code: 'invalid_context' } });
      const traversal = await client.callTool({
        name: 'dangbot_file_extract',
        arguments: { contextId: capability.token, attachmentId: '../../etc/passwd', cursor: 0, maxChars: 500 }
      });
      expect(traversal.isError).toBe(true);

      const invalidVideoRoute = await client.callTool({
        name: 'dangbot_video_generate',
        arguments: {
          contextId: capability.token,
          prompt: 'test',
          mode: 'text-to-video',
          referenceImageIds: ['att_image1234']
        }
      });
      expect(invalidVideoRoute.isError).toBe(true);
      expect(payload(invalidVideoRoute)).toMatchObject({
        status: 'error', data: { code: 'invalid_video_route' }
      });

      const reflectionTask = db.createTask({
        roomId: 'room1', userId: 'user-a', origin: 'reflection', prompt: 'isolated reflection', status: 'processing'
      });
      const reflection = db.createMcpContext({
        taskId: reflectionTask.id,
        roomId: 'room1',
        userId: 'user-a',
        role: 'member',
        purpose: 'reflection',
        attachmentIds: [],
        ttlMs: 60_000
      });
      const reflectionBusinessTool = await client.callTool({
        name: 'dangbot_attachment_list', arguments: { contextId: reflection.token }
      });
      expect(reflectionBusinessTool.isError).toBe(true);
      expect(payload(reflectionBusinessTool)).toMatchObject({
        status: 'error', data: { code: 'reflection_tool_forbidden' }
      });
      const reflectionMemory = payload(await client.callTool({
        name: 'dangbot_memory_recall', arguments: { contextId: reflection.token }
      }));
      expect(reflectionMemory).toMatchObject({ status: 'ok' });
      const reflectionFeedback = payload(await client.callTool({
        name: 'dangbot_memory_feedback',
        arguments: {
          contextId: reflection.token,
          signal: 'user_correction',
          evidence: '用户明确纠正了当前答案。'
        }
      }));
      expect(reflectionFeedback).toMatchObject({
        status: 'ok',
        artifactIds: [],
        data: null
      });

      const staleAdminTask = db.createTask({
        roomId: 'room1', userId: 'former-admin', origin: 'interactive', prompt: 'admin work', status: 'processing'
      });
      const staleAdmin = db.createMcpContext({
        taskId: staleAdminTask.id,
        roomId: 'room1',
        userId: 'former-admin',
        role: 'system_admin',
        purpose: 'interactive',
        attachmentIds: [],
        ttlMs: 60_000
      });
      const staleRole = await client.callTool({
        name: 'dangbot_automation_create',
        arguments: {
          contextId: staleAdmin.token,
          name: 'forbidden',
          kind: 'reminder',
          scheduleType: 'once',
          schedule: { at: new Date(Date.now() + 60_000).toISOString() },
          timezone: 'Asia/Shanghai',
          prompt: 'must not persist'
        }
      });
      expect(staleRole.isError).toBe(true);
      expect(payload(staleRole)).toMatchObject({
        status: 'error', data: { code: 'admin_required' }
      });

      await writeFile(allowedPath, 'tampered');
      const tampered = await client.callTool({
        name: 'dangbot_file_extract',
        arguments: { contextId: capability.token, attachmentId: 'att_allowed1234', cursor: 0, maxChars: 500 }
      });
      expect(tampered.isError).toBe(true);
      expect(payload(tampered)).toMatchObject({
        status: 'error', data: { code: 'attachment_integrity_failed' }
      });

      server.cancelTask(capability.record.taskId);
      const replay = await client.callTool({
        name: 'dangbot_attachment_list', arguments: { contextId: capability.token }
      });
      expect(replay.isError).toBe(true);
      expect(db.resolveMcpContext(capability.token)).toBeUndefined();
    } finally {
      await transport.close().catch(() => undefined);
      await server.stop();
      db.close();
    }
  });

  it('scopes MemoryProvider recall by hashed Hermes session and rejects cross-group data', async () => {
    const fixture = await createFixture();
    const { server, transport, db, config } = fixture;
    try {
      const sessionKey = 'dangbot:scoped-session-secret';
      db.upsertHermesSession({
        sessionKeyHash: createHash('sha256').update(sessionKey).digest('hex'),
        roomId: 'room1', userId: 'user-a', epoch: 0, purpose: 'interactive', hermesSessionId: 'session-a'
      });
      db.addMemory({ scope: 'user', roomId: 'room1', userId: 'user-a', source: 'manual', content: 'allowed user memory' });
      db.addMemory({ scope: 'user', roomId: 'room2', userId: 'user-a', source: 'manual', content: 'foreign room memory' });
      db.addMemory({ scope: 'room', roomId: 'room1', source: 'manual', content: 'allowed room memory' });
      const response = await fetch(`http://127.0.0.1:${server.boundPort()}/internal/memory/prefetch`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.agent.memoryBridge.apiKey}`,
          'X-Hermes-Session-Key': sessionKey,
          'Content-Type': 'application/json'
        },
        body: '{}'
      });
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toContain('allowed user memory');
      expect(body).toContain('allowed room memory');
      expect(body).not.toContain('foreign room memory');
      expect(body).not.toContain(sessionKey);

      db.rotateHermesSession('room1', 'user-a');
      const replay = await fetch(`http://127.0.0.1:${server.boundPort()}/internal/memory/prefetch`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.agent.memoryBridge.apiKey}`,
          'X-Hermes-Session-Key': sessionKey,
          'Content-Type': 'application/json'
        },
        body: '{}'
      });
      expect(replay.status).toBe(403);
      await expect(replay.json()).resolves.toEqual({ error: 'stale_session' });
    } finally {
      await transport.close().catch(() => undefined);
      await server.stop();
      db.close();
    }
  });

  it('acquires the global video lease before asynchronous validation or supplier work', async () => {
    let releaseVideo!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseVideo = resolve; });
    const fixture = await createFixture((media, config) => {
      media.generateVideo = async () => {
        markStarted();
        await release;
        await mkdir(config.storage.outputsDir, { recursive: true });
        const outputPath = path.join(config.storage.outputsDir, 'leased.mp4');
        await writeFile(outputPath, Buffer.from('000000186674797069736f6d', 'hex'));
        return outputPath;
      };
    });
    const invoke = fixture.server as unknown as {
      videoGenerate(contextId: string, input: {
        prompt: string;
        mode: 'text-to-video';
        referenceImageIds: string[];
      }): Promise<unknown>;
    };
    try {
      const first = invoke.videoGenerate(fixture.capability.token, {
        prompt: 'first', mode: 'text-to-video', referenceImageIds: []
      });
      await started;
      await expect(invoke.videoGenerate(fixture.capability.token, {
        prompt: 'second', mode: 'text-to-video', referenceImageIds: []
      })).rejects.toThrow(/并发已满/);
      releaseVideo();
      await expect(first).resolves.toMatchObject({ status: 'ok' });
    } finally {
      releaseVideo();
      await fixture.transport.close().catch(() => undefined);
      await fixture.server.stop();
      fixture.db.close();
    }
  });
});

async function createFixture(
  customizeMedia?: (
    media: DashScopeMediaClient,
    config: Awaited<ReturnType<typeof makeTestConfig>>
  ) => void
) {
  const config = await makeTestConfig({
    agent: { mcp: { port: 0 } },
    auth: { rooms: [{ id: 'room1', enabled: true, admins: ['admin'] }] }
  });
  const db = AppDatabase.memory();
  db.seedConfig(config);
  const task = db.createTask({ roomId: 'room1', userId: 'user-a', origin: 'interactive', prompt: '原始复合请求', status: 'processing' });
  await mkdir(config.storage.uploadsDir, { recursive: true });
  const allowedPath = path.join(config.storage.uploadsDir, 'allowed.txt');
  const foreignPath = path.join(config.storage.uploadsDir, 'foreign.txt');
  const imagePath = path.join(config.storage.uploadsDir, 'reference.png');
  await writeFile(allowedPath, 'abcdef');
  await writeFile(foreignPath, 'secret');
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  await writeFile(imagePath, png);
  const now = new Date();
  const allowed = {
    id: 'att_allowed1234', roomId: 'room1', userId: 'user-a', messageId: 'm1',
    fileName: 'allowed.txt', filePath: allowedPath, mimeType: 'text/plain', sizeBytes: 6,
    hash: createHash('sha256').update('abcdef').digest('hex'), kind: 'file' as const, createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString()
  };
  const foreign = {
    ...allowed,
    id: 'att_foreign1234',
    userId: 'user-b',
    fileName: 'foreign.txt',
    filePath: foreignPath,
    hash: createHash('sha256').update('secret').digest('hex')
  };
  const image = {
    ...allowed,
    id: 'att_image1234',
    fileName: 'reference.png',
    filePath: imagePath,
    mimeType: 'image/png',
    sizeBytes: png.length,
    hash: createHash('sha256').update(png).digest('hex'),
    kind: 'image' as const
  };
  db.addAttachment(allowed);
  db.addAttachment(foreign);
  db.addAttachment(image);
  db.linkTaskAttachments(task.id, [allowed, foreign, image]);
  const capability = db.createMcpContext({
    taskId: task.id, roomId: 'room1', userId: 'user-a', role: 'member', purpose: 'interactive',
    attachmentIds: [allowed.id, image.id], ttlMs: 60_000
  });
  const media = new DashScopeMediaClient(config.media, config.storage.outputsDir);
  customizeMedia?.(media, config);
  const server = new DangBotMcpServer(
    config, db, media,
    new FileService(config), new ArtifactBroker(config, db),
    new PortableCodeSandbox(config.agent.sandbox), silentLogger()
  );
  await server.start();
  const health = await fetch(`http://127.0.0.1:${server.boundPort()}/health`);
  expect(health.status).toBe(401);
  const client = new Client({ name: 'dangbot-test', version: '2.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.boundPort()}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${config.agent.mcp.apiKey}` } }
  });
  await client.connect(transport);
  return { config, db, task, capability, server, client, transport, allowedPath };
}

function payload(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== 'object' || !('content' in result) || !Array.isArray(result.content)) {
    throw new Error('Missing MCP content');
  }
  const text = result.content.find((entry): entry is { type: 'text'; text: string } =>
    Boolean(entry && typeof entry === 'object' && 'type' in entry && entry.type === 'text')
  );
  if (!text) throw new Error('Missing MCP text content');
  return JSON.parse(text.text) as Record<string, unknown>;
}
