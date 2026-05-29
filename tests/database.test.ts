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

  it('revokes admins removed from config', async () => {
    const db = AppDatabase.memory();
    db.seedConfig(
      await makeTestConfig({
        auth: {
          systemAdmins: ['sys'],
          rooms: [{ id: 'room1', topic: '测试群', enabled: true, admins: ['admin'] }]
        }
      })
    );
    expect(db.getUserRole('room1', 'sys')).toBe('system_admin');
    expect(db.getUserRole('room1', 'admin')).toBe('group_admin');

    db.seedConfig(
      await makeTestConfig({
        auth: {
          systemAdmins: [],
          rooms: [{ id: 'room1', topic: '测试群', enabled: true, admins: [] }]
        }
      })
    );

    expect(db.getUserRole('room1', 'sys')).toBe('member');
    expect(db.getUserRole('room1', 'admin')).toBe('member');
    db.close();
  });

  it('does not bind configured topic-only rooms unless explicitly allowed', async () => {
    const config = await makeTestConfig({
      auth: {
        systemAdmins: [],
        allowTopicRoomBinding: false,
        rooms: [{ topic: '重名群', enabled: true, admins: [] }]
      }
    });
    const db = AppDatabase.memory();
    db.seedConfig(config);

    expect(db.resolveRoom('actual-room-id', '重名群')).toBeUndefined();
    expect(db.resolveRoom('actual-room-id', '重名群', { allowTopicBinding: true })).toMatchObject({
      id: 'actual-room-id',
      authorized: true
    });
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
