import { describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/storage/database.js';
import { makeTestConfig } from './helpers.js';

describe('AppDatabase', () => {
  it('seeds configured rooms and resolves roles', async () => {
    const config = await makeTestConfig();
    const db = AppDatabase.memory();
    db.seedConfig(config);

    expect(db.resolveRoom('room1', '测试群')).toMatchObject({
      authorized: true,
      enabled: false
    });
    expect(db.getUserRole('room1', 'admin')).toBe('group_admin');
    expect(db.getUserRole('room1', 'sys')).toBe('system_admin');
    db.close();
  });

  it('isolates user contexts inside the same room', () => {
    const db = AppDatabase.memory();
    db.appendContext({ scope: 'user', roomId: 'room1', userId: 'u1', role: 'user', content: 'one' });
    db.appendContext({ scope: 'user', roomId: 'room1', userId: 'u2', role: 'user', content: 'two' });

    expect(db.getContext({ scope: 'user', roomId: 'room1', userId: 'u1', limit: 10 })).toEqual([
      { role: 'user', content: 'one' }
    ]);
    db.close();
  });

  it('persists user and global memories separately', () => {
    const db = AppDatabase.memory();

    db.addMemory({ scope: 'user', roomId: 'room1', userId: 'u1', content: '喜欢短回答' });
    db.addMemory({ scope: 'user', roomId: 'room1', userId: 'u2', content: '喜欢详细回答' });
    db.addMemory({ scope: 'global', roomId: 'room1', content: '默认使用中文' });

    expect(db.listMemories({ scope: 'user', roomId: 'room1', userId: 'u1', limit: 10 }).map((m) => m.content)).toEqual([
      '喜欢短回答'
    ]);
    expect(db.listMemories({ scope: 'global', roomId: 'room2', limit: 10 }).map((m) => m.content)).toEqual([
      '默认使用中文'
    ]);

    expect(db.clearMemories({ scope: 'user', roomId: 'room1', userId: 'u1' })).toBe(1);
    expect(db.listMemories({ scope: 'user', roomId: 'room1', userId: 'u1', limit: 10 })).toEqual([]);
    db.close();
  });
});
