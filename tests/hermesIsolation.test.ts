import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArtifactBroker } from '../src/services/artifacts/artifactBroker.js';
import type { HermesBackendClient } from '../src/services/hermes/hermesBackendClient.js';
import { HermesTaskExecutor } from '../src/services/hermes/hermesTaskExecutor.js';
import { AppDatabase } from '../src/storage/database.js';
import { makeTestConfig, silentLogger } from './helpers.js';

describe('Hermes task isolation', () => {
  it('uses expiring opaque MCP capabilities and rejects revoked or foreign tokens', async () => {
    const config = await makeTestConfig({
      auth: { rooms: [{ id: 'room1', enabled: true, admins: ['admin'] }] }
    });
    const db = AppDatabase.memory();
    db.seedConfig(config);
    const task = db.createTask({
      roomId: 'room1',
      userId: 'user-a',
      requestType: 'qa',
      prompt: 'x'
    });
    const capability = db.createMcpContext({
      taskId: task.id,
      roomId: task.roomId,
      userId: task.userId,
      role: 'member',
      attachmentIds: [],
      ttlMs: 60_000
    });

    expect(db.resolveMcpContext(capability.token)).toMatchObject({
      taskId: task.id,
      roomId: 'room1',
      userId: 'user-a'
    });
    expect(capability.record.tokenHash).not.toBe(capability.token);
    expect(db.resolveMcpContext(`${capability.token}x`)).toBeUndefined();
    db.revokeMcpContext(task.id);
    expect(db.resolveMcpContext(capability.token)).toBeUndefined();
    db.close();
  });

  it('only registers and resolves hashed artifacts inside the configured output root', async () => {
    const config = await makeTestConfig();
    await mkdir(config.storage.outputsDir, { recursive: true });
    const db = AppDatabase.memory();
    const task = db.createTask({
      roomId: 'room1',
      userId: 'user-a',
      requestType: 'qa',
      prompt: 'x'
    });
    const broker = new ArtifactBroker(config, db);
    const safeFile = path.join(config.storage.outputsDir, 'result.txt');
    await writeFile(safeFile, 'safe result');
    const artifacts = await broker.registerToolResult(task.id, 'run_1', {
      kind: 'file',
      filePath: safeFile,
      summary: safeFile
    });

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(broker.resolveForDelivery(artifacts[0]!)).resolves.toMatchObject({
      displayName: 'result.txt'
    });

    const outside = path.join(path.dirname(config.storage.outputsDir), 'outside.txt');
    await writeFile(outside, 'not allowed');
    await expect(
      broker.registerToolResult(task.id, 'run_2', {
        kind: 'file',
        filePath: outside
      })
    ).rejects.toThrow(/输出目录/);

    const symlinkPath = path.join(config.storage.outputsDir, 'linked-outside.txt');
    await symlink(outside, symlinkPath);
    await expect(
      broker.registerToolResult(task.id, 'run_3', {
        kind: 'file',
        filePath: symlinkPath
      })
    ).rejects.toThrow(/输出目录/);

    await writeFile(safeFile, 'tampered result with a different size');
    await expect(broker.resolveForDelivery(artifacts[0]!)).rejects.toThrow(/大小已变化|校验失败/);
    db.close();
  });

  it('directs Hermes search tasks to native web tools instead of the MCP search wrapper', async () => {
    const config = await makeTestConfig({
      agent: { backend: 'hermes' },
      search: { enabled: true, provider: 'hermes' },
      auth: { rooms: [{ id: 'room1', enabled: true, admins: [] }] }
    });
    const db = AppDatabase.memory();
    db.seedConfig(config);
    const task = db.createTask({
      roomId: 'room1',
      userId: 'user-a',
      requestType: 'web_search',
      prompt: '搜索今天的模型新闻',
      toolName: 'web.search',
      status: 'processing'
    });
    let instructions = '';
    const client = {
      configured: () => true,
      sessionIdentity: () => ({
        sessionId: 'session-id',
        sessionKey: 'session-key',
        sessionKeyHash: 'session-key-hash'
      }),
      run: async (input: { instructions: string; onStarted?: (runId: string) => void }) => {
        instructions = input.instructions;
        input.onStarted?.('run-id');
        return { runId: 'run-id', status: 'completed', output: '搜索完成' };
      }
    } as unknown as HermesBackendClient;
    const executor = new HermesTaskExecutor(
      config,
      db,
      client,
      new ArtifactBroker(config, db),
      silentLogger(),
      'system prompt'
    );

    await executor.execute(task, [], new AbortController().signal, {
      stage: async () => undefined
    });

    expect(instructions).toContain('必须使用 Hermes 内建 web/browser 工具');
    expect(instructions).toContain('不要通过 dangbot_execute_tool 调用 web.search');
    expect(instructions).not.toContain('建议优先考虑的工具：web.search');
    db.close();
  });
});
