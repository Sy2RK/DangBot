import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArtifactBroker } from '../src/services/artifacts/artifactBroker.js';
import { AppDatabase } from '../src/storage/database.js';
import { makeTestConfig } from './helpers.js';

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
});
