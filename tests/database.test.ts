import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/storage/database.js';
import { makeTestConfig } from './helpers.js';

describe('Hermes v2 database', () => {
  it('stores tasks with origin and no classifier/tool routing fields', async () => {
    const db = AppDatabase.memory();
    const config = await makeTestConfig();
    db.seedConfig(config);
    const task = db.createTask({ roomId: 'room1', userId: 'u1', origin: 'interactive', prompt: '复合请求原文' });
    expect(task).toMatchObject({ origin: 'interactive', prompt: '复合请求原文' });
    expect(task).not.toHaveProperty('requestType');
    expect(task).not.toHaveProperty('toolName');
    expect(task).not.toHaveProperty('toolInputJson');
    db.close();
  });

  it('isolates persistent sessions by room, user, epoch and reflection purpose', () => {
    const db = AppDatabase.memory();
    db.upsertHermesSession({ sessionKeyHash: 'a'.repeat(64), roomId: 'r1', userId: 'u1', epoch: 0, purpose: 'interactive', hermesSessionId: 's1' });
    db.upsertHermesSession({ sessionKeyHash: 'b'.repeat(64), roomId: 'r1', userId: 'u1', epoch: 0, purpose: 'reflection', hermesSessionId: 's2' });
    expect(db.getHermesSessionByHash('a'.repeat(64))?.purpose).toBe('interactive');
    expect(db.getHermesSessionByHash('b'.repeat(64))?.purpose).toBe('reflection');
    expect(db.rotateHermesSession('r1', 'u1')).toBe(1);
    db.close();
  });

  it('invalidates crash-surviving MCP capabilities before a new process accepts work', () => {
    const db = AppDatabase.memory();
    const task = db.createTask({ roomId: 'r1', userId: 'u1', prompt: 'work' });
    const capability = db.createMcpContext({
      taskId: task.id,
      roomId: 'r1',
      userId: 'u1',
      role: 'member',
      attachmentIds: [],
      ttlMs: 60_000
    });
    expect(db.resolveMcpContext(capability.token)).toBeDefined();
    expect(db.invalidateAllMcpContexts()).toBe(1);
    expect(db.resolveMcpContext(capability.token)).toBeUndefined();
    db.close();
  });

  it('keeps user, room, proposals and approved agent lessons scoped', () => {
    const db = AppDatabase.memory();
    const userMemory = db.addMemory({ scope: 'user', roomId: 'r1', userId: 'u1', source: 'manual', content: '喜欢简短回答' });
    db.addMemory({ scope: 'user', roomId: 'r1', userId: 'u2', source: 'manual', content: '其他人的记忆' });
    db.addMemory({ scope: 'room', roomId: 'r1', source: 'manual', content: '群项目是 DangBot' });
    const proposal = db.addMemoryProposal({ scope: 'agent', roomId: 'r1', content: '工具失败先读结构化错误再换参数', evidence: '一次成功恢复', confidence: 0.99 });
    db.resolveMemoryProposal(proposal.id, true, 'sys');
    expect(db.listMemories({ scope: 'user', roomId: 'r2', userId: 'u1', limit: 10 })).toEqual([]);
    expect(db.listMemories({ scope: 'room', roomId: 'r1', limit: 10 })).toHaveLength(1);
    expect(db.listAgentLessons()).toHaveLength(1);
    expect(db.deleteUserMemory(userMemory.id, 'r1', 'u2')).toBe(false);
    expect(db.deleteUserMemory(userMemory.id, 'r1', 'u1')).toBe(true);
    expect(db.listMemories({ scope: 'user', roomId: 'r1', userId: 'u2', limit: 10 })).toHaveLength(1);
    db.close();
  });

  it('keeps the public room context bounded and expiring', () => {
    const db = AppDatabase.memory();
    db.insertMessage({ id: 'old', roomId: 'r1', userId: 'u1', text: 'old', mentioned: false, createdAt: '2020-01-01T00:00:00.000Z' });
    db.insertMessage({ id: 'm1', roomId: 'r1', userId: 'u1', text: 'one', mentioned: false });
    db.insertMessage({ id: 'm2', roomId: 'r1', userId: 'u1', text: 'two', mentioned: false });
    db.insertMessage({ id: 'm3', roomId: 'r1', userId: 'u1', text: 'three', mentioned: false });
    db.pruneRoomMessages('r1', 2);
    expect(db.listRecentRoomMessages('r1', 10).map((entry) => entry.text)).toEqual(['two', 'three']);
    db.close();
  });

  it('physically removes legacy task routing columns during migration', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dangbot-migration-'));
    const file = path.join(dir, 'old.sqlite');
    const raw = new Database(file);
    raw.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, room_id TEXT NOT NULL, user_id TEXT NOT NULL,
        request_type TEXT NOT NULL, status TEXT NOT NULL, prompt TEXT NOT NULL,
        tool_name TEXT, tool_input_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE memories (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, room_id TEXT NOT NULL, user_id TEXT,
        source TEXT NOT NULL DEFAULT 'manual', content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO tasks VALUES ('t1','r1','u1','qa','completed','hi','web.search','{}','2026-01-01','2026-01-01');
      INSERT INTO memories VALUES ('m1','global','*',NULL,'automatic','leak','2026-01-01','2026-01-01');
    `);
    raw.close();
    const db = await AppDatabase.open(file);
    expect(db.getTask('t1')).toMatchObject({ origin: 'interactive', prompt: 'hi' });
    db.close();
    const inspect = new Database(file);
    const columns = inspect.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toEqual(expect.arrayContaining(['request_type', 'tool_name', 'tool_input_json']));
    expect((inspect.prepare('SELECT COUNT(*) AS count FROM memories').get() as { count: number }).count).toBe(0);
    inspect.close();
  });
});
