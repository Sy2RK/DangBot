import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import { ArtifactBroker } from '../src/services/artifacts/artifactBroker.js';
import { FileService } from '../src/services/files/fileService.js';
import { OpenAICompatibleClient } from '../src/services/llm/openaiCompatibleClient.js';
import { DangBotMcpServer } from '../src/services/mcp/dangbotMcpServer.js';
import { PortableCodeSandbox } from '../src/services/sandbox/portableCodeSandbox.js';
import { AppDatabase } from '../src/storage/database.js';
import { makeTestConfig, silentLogger } from './helpers.js';

describe('DangBotMcpServer', () => {
  it('requires bearer auth and scopes every call to an opaque task context', async () => {
    const config = await makeTestConfig({
      agent: { mcp: { port: 0 } },
      auth: { rooms: [{ id: 'room1', enabled: true, admins: ['admin'] }] }
    });
    const db = AppDatabase.memory();
    db.seedConfig(config);
    const task = db.createTask({
      roomId: 'room1',
      userId: 'user-a',
      requestType: 'qa',
      prompt: '计算 1+1',
      status: 'processing'
    });
    const now = new Date();
    const allowedAttachment = {
      id: 'attachment-allowed',
      roomId: 'room1',
      userId: 'user-a',
      messageId: 'message-a',
      fileName: 'allowed.txt',
      filePath: '/not/exposed/allowed.txt',
      mimeType: 'text/plain',
      sizeBytes: 10,
      hash: 'hash-a',
      kind: 'file' as const,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString()
    };
    const foreignAttachment = {
      ...allowedAttachment,
      id: 'attachment-foreign',
      userId: 'user-b',
      messageId: 'message-b',
      fileName: 'foreign.txt',
      filePath: '/not/exposed/foreign.txt',
      hash: 'hash-b'
    };
    db.addAttachment(allowedAttachment);
    db.addAttachment(foreignAttachment);
    db.linkTaskAttachments(task.id, [allowedAttachment, foreignAttachment]);
    db.addMemory({ scope: 'user', roomId: 'room1', userId: 'user-a', content: 'allowed memory' });
    db.addMemory({ scope: 'user', roomId: 'room1', userId: 'user-b', content: 'foreign memory' });
    db.addMemory({ scope: 'global', roomId: 'room1', content: 'allowed room memory' });
    db.addMemory({ scope: 'global', roomId: 'room2', content: 'foreign room memory' });
    const capability = db.createMcpContext({
      taskId: task.id,
      roomId: task.roomId,
      userId: task.userId,
      role: 'member',
      attachmentIds: [allowedAttachment.id],
      ttlMs: 60_000
    });
    const llm = new OpenAICompatibleClient(config.llm, config.storage.outputsDir, 'test');
    const server = new DangBotMcpServer(
      config,
      db,
      llm,
      new FileService(config),
      new ArtifactBroker(config, db),
      new PortableCodeSandbox(config.agent.sandbox),
      silentLogger(),
      'test'
    );

    await server.start();
    const port = server.boundPort();
    expect(port).toBeTypeOf('number');
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(401);

    const client = new Client({ name: 'dangbot-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${config.agent.mcp.apiKey}` } }
    });
    try {
      await client.connect(transport);
      const valid = await client.callTool({
        name: 'dangbot_execute_javascript',
        arguments: { contextId: capability.token, code: 'return 1 + 1;' }
      });
      const validPayload = textPayload(valid.content);
      expect(valid.isError).not.toBe(true);
      expect(validPayload).toEqual({
        status: 'ok',
        summary: 'JavaScript 计算已完成。',
        artifactIds: [],
        data: { value: 2, stdout: '', truncated: false }
      });
      expect(JSON.stringify(validPayload)).not.toContain(config.storage.outputsDir);

      const attachments = textPayload(
        (
          await client.callTool({
            name: 'dangbot_list_attachments',
            arguments: { contextId: capability.token }
          })
        ).content
      );
      expect(JSON.stringify(attachments)).toContain('allowed.txt');
      expect(JSON.stringify(attachments)).not.toContain('foreign.txt');
      expect(JSON.stringify(attachments)).not.toContain('/not/exposed/');

      const memories = textPayload(
        (
          await client.callTool({
            name: 'dangbot_list_memories',
            arguments: { contextId: capability.token }
          })
        ).content
      );
      expect(JSON.stringify(memories)).toContain('allowed memory');
      expect(JSON.stringify(memories)).toContain('allowed room memory');
      expect(JSON.stringify(memories)).not.toContain('foreign memory');
      expect(JSON.stringify(memories)).not.toContain('foreign room memory');

      const approvalRequired = await client.callTool({
        name: 'dangbot_execute_tool',
        arguments: {
          contextId: capability.token,
          toolName: 'video.generate',
          input: { prompt: '生成一段测试视频' }
        }
      });
      expect(approvalRequired.isError).toBe(true);
      expect(db.getTask(task.id)?.status).toBe('waiting_approval');

      const forged = await client.callTool({
        name: 'dangbot_capabilities',
        arguments: { contextId: `${capability.token}x` }
      });
      expect(forged.isError).toBe(true);
      expect(textPayload(forged.content)).toMatchObject({
        status: 'error',
        artifactIds: [],
        data: null
      });

      server.cancelTask(task.id);
      const replay = await client.callTool({
        name: 'dangbot_capabilities',
        arguments: { contextId: capability.token }
      });
      expect(replay.isError).toBe(true);
    } finally {
      await transport.close().catch(() => undefined);
      await server.stop();
      db.close();
    }
  });
});

function textPayload(content: unknown): Record<string, unknown> {
  if (!Array.isArray(content)) throw new Error('Missing MCP content');
  const text = content.find((entry): entry is { type: 'text'; text: string } =>
    Boolean(entry && typeof entry === 'object' && 'type' in entry && entry.type === 'text')
  );
  if (!text) throw new Error('Missing MCP text result');
  return JSON.parse(text.text) as Record<string, unknown>;
}
