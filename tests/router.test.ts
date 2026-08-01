import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BotRequestRouter } from '../src/core/router.js';
import { TaskQueue } from '../src/domain/taskQueue.js';
import { ArtifactBroker } from '../src/services/artifacts/artifactBroker.js';
import { FileService } from '../src/services/files/fileService.js';
import type { HermesTaskExecutor } from '../src/services/hermes/hermesTaskExecutor.js';
import { AppDatabase } from '../src/storage/database.js';
import type { AttachmentRecord, IncomingMessage, TaskRecord } from '../src/types.js';
import { makeTestConfig, MemoryResponder, silentLogger } from './helpers.js';

describe('Hermes-only微信边缘路由', () => {
  it('forwards the exact raw compound request and safe attachment IDs without classification', async () => {
    const seen: Array<{ task: TaskRecord; attachments: AttachmentRecord[] }> = [];
    const fixture = await createRouter(async (task, attachments) => {
      seen.push({ task, attachments });
      return { text: '完成复合请求' };
    });
    const recent = await addAttachment(fixture, 'recent.txt', 'recent');
    const message = incoming('请搜索资料，分析附件，再生成一份 DOCX');
    const currentPath = path.join(path.dirname(fixture.config.storage.sqlitePath), 'current.txt');
    await writeFile(currentPath, 'current');
    message.attachments = [{ name: 'current.txt', path: currentPath, mimeType: 'text/plain', sizeBytes: 7, kind: 'file' }];
    const responder = new MemoryResponder();
    await fixture.router.handleMessage(message, responder);
    await waitFor(() => fixture.db.listRoomTasks('room1')[0]?.status === 'completed');

    expect(seen).toHaveLength(1);
    expect(seen[0]?.task).toMatchObject({
      origin: 'interactive',
      prompt: '请搜索资料，分析附件，再生成一份 DOCX'
    });
    expect(seen[0]?.task).not.toHaveProperty('requestType');
    expect(seen[0]?.attachments.map((attachment) => attachment.id)).toContain(recent.id);
    expect(seen[0]?.attachments.some((attachment) => attachment.fileName === 'current.txt')).toBe(true);
    expect(responder.texts.join('\n')).toContain('完成复合请求');
    fixture.db.close();
  });

  it('rotates only the current group-user Hermes epoch on 清空上下文', async () => {
    const fixture = await createRouter(async () => ({ text: 'unused' }));
    fixture.db.upsertHermesSession({
      sessionKeyHash: 'a'.repeat(64), roomId: 'room1', userId: 'user1', epoch: 0,
      purpose: 'interactive', hermesSessionId: 's0'
    });
    await fixture.router.handleMessage(incoming('清空上下文'), new MemoryResponder());
    expect(fixture.db.getSessionEpoch('room1', 'user1')).toBe(1);
    fixture.db.close();
  });

  it('delivers validated artifacts as real attachments instead of path text', async () => {
    const fixture = await createRouter(async (task) => {
      await mkdir(fixture.config.storage.outputsDir, { recursive: true });
      const filePath = path.join(fixture.config.storage.outputsDir, 'report.txt');
      await writeFile(filePath, 'real report');
      await fixture.broker.registerToolResult(task.id, 'run-artifact', { filePath });
      return { text: '报告完成' };
    });
    const responder = new MemoryResponder();
    await fixture.router.handleMessage(incoming('生成报告文件'), responder);
    await waitFor(() => responder.files.length === 1);
    expect(responder.files[0]).toMatch(/\/outputs\/report\.txt$/u);
    expect(responder.texts.join('\n')).not.toContain(fixture.config.storage.outputsDir);
    expect(fixture.db.listRoomTasks('room1')[0]).toMatchObject({ status: 'completed', resultKind: 'file' });
    fixture.db.close();
  });

  it('lists scoped proposal IDs and deletes only the requester personal memory', async () => {
    const fixture = await createRouter(async () => ({ text: 'unused' }));
    const own = fixture.db.addMemory({
      scope: 'user', roomId: 'room1', userId: 'user1', source: 'manual', content: '喜欢简短回答'
    });
    const foreign = fixture.db.addMemory({
      scope: 'user', roomId: 'room1', userId: 'user2', source: 'manual', content: '其他人的记忆'
    });
    const ownProposal = fixture.db.addMemoryProposal({
      scope: 'user', roomId: 'room1', userId: 'user1', content: '以后默认中文', evidence: '用户原话', confidence: 0.9
    });
    fixture.db.addMemoryProposal({
      scope: 'user', roomId: 'room1', userId: 'user2', content: '其他人的提案', evidence: '证据', confidence: 0.9
    });

    const proposals = new MemoryResponder();
    await fixture.router.handleMessage(incoming('记忆提案'), proposals);
    expect(proposals.texts.join('\n')).toContain(ownProposal.id);
    expect(proposals.texts.join('\n')).not.toContain('其他人的提案');

    await fixture.router.handleMessage(incoming(`忘记 ${foreign.id}`), new MemoryResponder());
    expect(fixture.db.listMemories({ scope: 'user', roomId: 'room1', userId: 'user2', limit: 10 })).toHaveLength(1);
    await fixture.router.handleMessage(incoming(`忘记 ${own.id}`), new MemoryResponder());
    expect(fixture.db.listMemories({ scope: 'user', roomId: 'room1', userId: 'user1', limit: 10 })).toEqual([]);
    fixture.db.close();
  });
});

async function createRouter(
  execute: (task: TaskRecord, attachments: AttachmentRecord[]) => Promise<{ text?: string }>
) {
  const config = await makeTestConfig({ auth: { rooms: [{ id: 'room1', topic: '测试群', enabled: true, admins: ['admin'] }] } });
  const db = AppDatabase.memory();
  db.seedConfig(config);
  const logger = silentLogger();
  const queue = new TaskQueue(db, logger, {
    maxConcurrentTasks: 2, maxConcurrentLongTasks: 1, taskTimeoutMs: 5_000
  });
  const broker = new ArtifactBroker(config, db);
  const hermes = {
    execute: vi.fn(async (task: TaskRecord, attachments: AttachmentRecord[]) => execute(task, attachments)),
    stopTask: vi.fn(async () => undefined),
    approveTask: vi.fn(async () => true),
    health: vi.fn(async () => ({ status: 'ok' })),
    configured: () => true
  } as unknown as HermesTaskExecutor;
  const router = new BotRequestRouter(config, db, queue, new FileService(config), broker, logger, hermes);
  return { config, db, queue, broker, hermes, router };
}

async function addAttachment(fixture: Awaited<ReturnType<typeof createRouter>>, name: string, content: string) {
  const filePath = path.join(path.dirname(fixture.config.storage.sqlitePath), name);
  await writeFile(filePath, content);
  const record: AttachmentRecord = {
    id: `att_${name.replace(/\W/gu, '')}12345678`, roomId: 'room1', userId: 'user1',
    messageId: 'old', fileName: name, filePath, mimeType: 'text/plain',
    sizeBytes: Buffer.byteLength(content), hash: 'a'.repeat(64), kind: 'file',
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  fixture.db.addAttachment(record);
  return record;
}

function incoming(text: string): IncomingMessage {
  return {
    id: `msg_${Math.random()}`, roomId: 'room1', roomTopic: '测试群', senderId: 'user1', senderName: '用户一',
    text: `@DangBot ${text}`, mentioned: true, mentionText: text, attachments: [], timestamp: new Date()
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
