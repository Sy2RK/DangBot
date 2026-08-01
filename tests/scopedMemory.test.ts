import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ArtifactBroker } from '../src/services/artifacts/artifactBroker.js';
import { FileService } from '../src/services/files/fileService.js';
import { DashScopeMediaClient } from '../src/services/llm/dashScopeClient.js';
import { DangBotMcpServer } from '../src/services/mcp/dangbotMcpServer.js';
import { PortableCodeSandbox } from '../src/services/sandbox/portableCodeSandbox.js';
import { AppDatabase } from '../src/storage/database.js';
import { makeTestConfig, silentLogger } from './helpers.js';

describe('dangbot_scoped MemoryProvider bridge', () => {
  it('enforces 0.95 auto-write, exact evidence, one-per-batch and approval scopes', async () => {
    const config = await makeTestConfig({
      agent: { mcp: { port: 0 } },
      auth: { rooms: [{ id: 'room1', enabled: true, admins: ['admin'] }] }
    });
    const db = AppDatabase.memory();
    db.seedConfig(config);
    const task = db.createTask({
      roomId: 'room1', userId: 'u1', origin: 'reflection', status: 'processing',
      prompt: '用户原话：我长期偏好简短回答。'
    });
    const sessionKey = 'dangbot:reflection-session';
    db.upsertHermesSession({
      sessionKeyHash: createHash('sha256').update(sessionKey).digest('hex'),
      roomId: 'room1', userId: 'u1', epoch: 0, purpose: 'reflection', hermesSessionId: 'reflection-session'
    });
    const server = new DangBotMcpServer(
      config, db, new DashScopeMediaClient(config.media, config.storage.outputsDir),
      new FileService(config), new ArtifactBroker(config, db),
      new PortableCodeSandbox(config.agent.sandbox), silentLogger()
    );
    await server.start();
    db.createTask({
      roomId: 'room1', userId: 'u1', origin: 'interactive', status: 'processing', prompt: 'newer interactive task'
    });
    const call = (args: Record<string, unknown>) => fetch(`http://127.0.0.1:${server.boundPort()}/internal/memory/tool`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.agent.memoryBridge.apiKey}`,
        'X-Hermes-Session-Key': sessionKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'dangbot_memory_propose', arguments: args })
    }).then((response) => response.json() as Promise<Record<string, any>>);
    try {
      const auto = await call({ scope: 'user', content: '长期偏好简短回答', evidence: '我长期偏好简短回答。', confidence: 0.95 });
      expect(auto.data.status).toBe('auto_approved');
      expect(db.listMemories({ scope: 'user', roomId: 'room1', userId: 'u1', limit: 10 })).toHaveLength(1);

      const second = await call({ scope: 'user', content: '长期偏好中文回答', evidence: '我长期偏好简短回答。', confidence: 0.99 });
      expect(second.data.status).toBe('pending');

      const room = await call({ scope: 'room', content: '群内都用中文', evidence: '我长期偏好简短回答。', confidence: 1 });
      expect(room.data.status).toBe('pending');
      const agent = await call({ scope: 'agent', content: '工具失败后缩小输入重试', evidence: '我长期偏好简短回答。', confidence: 1 });
      expect(agent.data.status).toBe('pending');
      db.resolveMemoryProposal(String(agent.data.proposalId), true, 'sys');
      expect(db.listAgentLessons()).toHaveLength(1);
      expect(db.getTask(task.id)?.origin).toBe('reflection');
    } finally {
      await server.stop();
      db.close();
    }
  });

  it('does not auto-write assistant evidence or conflicting preferences', async () => {
    const config = await makeTestConfig({
      agent: { mcp: { port: 0 } },
      auth: { rooms: [{ id: 'room1', enabled: true, admins: [] }] }
    });
    const db = AppDatabase.memory();
    db.seedConfig(config);
    db.addMemory({
      scope: 'user', roomId: 'room1', userId: 'u1', source: 'manual', content: '回答请简短'
    });
    const task = db.createTask({
      roomId: 'room1',
      userId: 'u1',
      origin: 'reflection',
      status: 'processing',
      prompt: '用户原话：回答请详细\n当时最终回答：用户喜欢绿色'
    });
    const sessionKey = 'dangbot:reflection-negative-session';
    db.upsertHermesSession({
      sessionKeyHash: createHash('sha256').update(sessionKey).digest('hex'),
      roomId: 'room1', userId: 'u1', epoch: 0, purpose: 'reflection', hermesSessionId: 'reflection-negative'
    });
    const server = new DangBotMcpServer(
      config, db, new DashScopeMediaClient(config.media, config.storage.outputsDir),
      new FileService(config), new ArtifactBroker(config, db),
      new PortableCodeSandbox(config.agent.sandbox), silentLogger()
    );
    await server.start();
    const propose = (content: string, evidence: string) =>
      fetch(`http://127.0.0.1:${server.boundPort()}/internal/memory/tool`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.agent.memoryBridge.apiKey}`,
          'X-Hermes-Session-Key': sessionKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: 'dangbot_memory_propose',
          arguments: { scope: 'user', content, evidence, confidence: 1 }
        })
      }).then((response) => response.json() as Promise<Record<string, any>>);
    try {
      expect((await propose('用户长期住在上海', '回答请详细')).data.status).toBe('pending');
      expect((await propose('回答请详细', '回')).data.status).toBe('pending');
      expect((await propose('联系方式是13800138000', '联系方式是13800138000')).data.status).toBe('pending');
      expect((await propose('喜欢绿色', '用户喜欢绿色')).data.status).toBe('pending');
      expect((await propose('回答请详细', '回答请详细')).data.status).toBe('pending');
      expect(db.listMemories({ scope: 'user', roomId: 'room1', userId: 'u1', limit: 10 })).toHaveLength(1);
      expect(db.getTask(task.id)?.origin).toBe('reflection');
    } finally {
      await server.stop();
      db.close();
    }
  });
});
