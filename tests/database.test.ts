import { describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/storage/database.js';
import { makeTestConfig } from './helpers.js';

describe('AppDatabase', () => {
  it('lists recent completed text tasks for document generation', async () => {
    const config = await makeTestConfig();
    const db = AppDatabase.memory();
    db.seedConfig(config);
    const source = db.createTask({
      roomId: 'room1',
      userId: 'user1',
      requestType: 'rewrite',
      prompt: '润色材料'
    });
    db.updateTask(source.id, {
      status: 'completed',
      resultKind: 'text',
      resultText: '润色后的正文'
    });
    const current = db.createTask({
      roomId: 'room1',
      userId: 'user1',
      requestType: 'document_generation',
      prompt: '做成 DOCX'
    });

    expect(db.listRecentCompletedTextTasks('room1', 'user1', current.id)).toMatchObject([
      { id: source.id, resultText: '润色后的正文' }
    ]);
    expect(db.listRecentCompletedRoomTextTasks('room1', current.id)).toMatchObject([
      { id: source.id, resultText: '润色后的正文' }
    ]);
    db.close();
  });

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
      id: 'topic:重名群',
      authorized: true
    });
    expect(db.resolveRoom('actual-room-id')).toMatchObject({
      id: 'topic:重名群',
      authorized: true
    });
    db.close();
  });

  it('resolves changed runtime ids to a configured stable room', async () => {
    const config = await makeTestConfig({
      auth: {
        systemAdmins: [],
        rooms: [
          {
            stableId: 'stable-room',
            id: 'runtime-old',
            runtimeIds: ['runtime-new'],
            topic: '测试群',
            enabled: true,
            admins: ['admin']
          }
        ]
      }
    });
    const db = AppDatabase.memory();
    db.seedConfig(config);

    expect(db.resolveRoom('runtime-old', '测试群')).toMatchObject({
      id: 'stable-room',
      authorized: true,
      enabled: true
    });
    expect(db.resolveRoom('runtime-new', '测试群')).toMatchObject({
      id: 'stable-room',
      authorized: true,
      enabled: true
    });
    expect(db.getUserRole('stable-room', 'admin')).toBe('group_admin');
    db.close();
  });

  it('merges old runtime room data into the configured stable room', async () => {
    const db = AppDatabase.memory();
    db.seedConfig(
      await makeTestConfig({
        auth: {
          systemAdmins: [],
          rooms: [{ id: 'runtime-old', topic: '测试群', enabled: true, admins: [] }]
        }
      })
    );
    db.appendContext({
      scope: 'user',
      roomId: 'runtime-old',
      userId: 'u1',
      role: 'user',
      content: '旧上下文'
    });
    db.addMemory({ scope: 'user', roomId: 'runtime-old', userId: 'u1', content: '旧记忆' });
    db.createTask({ roomId: 'runtime-old', userId: 'u1', requestType: 'qa', prompt: '旧任务' });

    db.seedConfig(
      await makeTestConfig({
        auth: {
          systemAdmins: [],
          rooms: [
            {
              stableId: 'stable-room',
              id: 'runtime-new',
              runtimeIds: ['runtime-old'],
              topic: '测试群',
              enabled: true,
              admins: []
            }
          ]
        }
      })
    );

    expect(db.resolveRoom('runtime-old')).toMatchObject({ id: 'stable-room', authorized: true });
    expect(db.resolveRoom('runtime-new')).toMatchObject({ id: 'stable-room', authorized: true });
    expect(
      db.getContext({ scope: 'user', roomId: 'stable-room', userId: 'u1', limit: 10 })
    ).toEqual([{ role: 'user', content: '旧上下文' }]);
    expect(
      db
        .listMemories({ scope: 'user', roomId: 'stable-room', userId: 'u1', limit: 10 })
        .map((m) => m.content)
    ).toEqual(['旧记忆']);
    expect(db.listRoomTasks('stable-room', 10).map((task) => task.prompt)).toEqual(['旧任务']);
    expect(db.listRoomTasks('runtime-old', 10)).toEqual([]);
    db.close();
  });

  it('binds a new runtime id by topic only when the authorized topic is unique', async () => {
    const config = await makeTestConfig({
      auth: {
        systemAdmins: [],
        allowTopicRoomBinding: true,
        rooms: [
          {
            stableId: 'stable-room',
            topic: '唯一群',
            enabled: true,
            admins: []
          }
        ]
      }
    });
    const db = AppDatabase.memory();
    db.seedConfig(config);

    expect(db.resolveRoom('runtime-fresh', '唯一群', { allowTopicBinding: true })).toMatchObject({
      id: 'stable-room',
      authorized: true,
      enabled: true
    });
    expect(db.resolveRoom('runtime-fresh')).toMatchObject({
      id: 'stable-room',
      authorized: true
    });
    db.close();
  });

  it('does not topic-bind a runtime id when multiple authorized rooms share a topic', async () => {
    const config = await makeTestConfig({
      auth: {
        systemAdmins: [],
        allowTopicRoomBinding: true,
        rooms: [
          { stableId: 'stable-a', topic: '重名群', enabled: true, admins: [] },
          { stableId: 'stable-b', topic: '重名群', enabled: true, admins: [] }
        ]
      }
    });
    const db = AppDatabase.memory();
    db.seedConfig(config);

    expect(db.resolveRoom('runtime-fresh', '重名群', { allowTopicBinding: true })).toBeUndefined();
    db.close();
  });

  it('isolates user contexts inside the same room', () => {
    const db = AppDatabase.memory();
    db.appendContext({
      scope: 'user',
      roomId: 'room1',
      userId: 'u1',
      role: 'user',
      content: 'one'
    });
    db.appendContext({
      scope: 'user',
      roomId: 'room1',
      userId: 'u2',
      role: 'user',
      content: 'two'
    });

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

    expect(
      db
        .listMemories({ scope: 'user', roomId: 'room1', userId: 'u1', limit: 10 })
        .map((m) => m.content)
    ).toEqual(['喜欢短回答']);
    expect(
      db.listMemories({ scope: 'global', roomId: 'room1', limit: 10 }).map((m) => m.content)
    ).toEqual(['默认使用中文']);
    expect(db.listMemories({ scope: 'global', roomId: 'room2', limit: 10 })).toEqual([]);

    expect(db.clearMemories({ scope: 'user', roomId: 'room1', userId: 'u1' })).toBe(1);
    expect(db.listMemories({ scope: 'user', roomId: 'room1', userId: 'u1', limit: 10 })).toEqual(
      []
    );
    db.close();
  });

  it('scopes an approval to the tool that was actually approved', () => {
    const db = AppDatabase.memory();
    const task = db.createTask({
      roomId: 'room1',
      userId: 'u1',
      requestType: 'video_generation',
      prompt: '生成视频',
      toolName: 'video.generate'
    });
    db.createApproval({
      taskId: task.id,
      roomId: 'room1',
      requesterId: 'u1',
      riskType: 'high_risk_tool:video.generate',
      toolName: 'video.generate'
    });
    db.resolveApproval(task.id, 'admin', true);

    expect(db.hasApprovedApproval(task.id, 'video.generate')).toBe(true);
    expect(db.hasApprovedApproval(task.id, 'voice.generate')).toBe(false);
    db.close();
  });
});
