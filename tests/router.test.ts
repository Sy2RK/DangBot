import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BotRequestRouter } from '../src/core/router.js';
import { TaskQueue } from '../src/domain/taskQueue.js';
import { FileService } from '../src/services/files/fileService.js';
import type { OpenAICompatibleClient } from '../src/services/llm/openaiCompatibleClient.js';
import { AppDatabase } from '../src/storage/database.js';
import type { IncomingMessage, RequestKind } from '../src/types.js';
import { makeTestConfig, MemoryResponder, silentLogger } from './helpers.js';

describe('BotRequestRouter', () => {
  it('does not reply to normal chat, then allows admin to enable room', async () => {
    const { router } = await setup();
    const responder = new MemoryResponder();

    await router.handleMessage(message({ mentioned: false, text: 'hello' }), responder);
    expect(responder.texts).toEqual([]);

    await router.handleMessage(
      message({ senderId: 'admin', senderName: 'Admin', mentioned: true, mentionText: '启用' }),
      responder
    );
    expect(responder.texts.at(-1)).toContain('醒啦');
  });

  it('replies to /health with a cat-toned local self-check', async () => {
    const { router, chatCalls } = await setup();
    const responder = new MemoryResponder();

    await router.handleMessage(
      message({ mentioned: true, mentionText: '/health', text: '@DangBot /health' }),
      responder
    );

    expect(responder.texts).toHaveLength(1);
    expect(responder.texts[0]).toContain('小当自检完成，喵。');
    expect(responder.texts[0]).toContain('微信入口：健康');
    expect(responder.texts[0]).toContain('本群授权：健康');
    expect(responder.texts[0]).toContain('数据库：健康');
    expect(responder.texts[0]).toContain('LLM：健康');
    expect(responder.texts[0]).toContain('自动化：健康');
    expect(chatCalls).toHaveLength(0);
  });

  it('runs a normal mentioned request after the room is enabled', async () => {
    const { router, db, chatCalls, chatOptions } = await setup({ enabled: true });
    const responder = new MemoryResponder();

    await router.handleMessage(
      message({ mentioned: true, mentionText: '解释 TypeScript strict mode' }),
      responder
    );

    await vi.waitFor(() => expect(responder.texts).toContain('mock answer'));
    expect(responder.texts).toEqual(['mock answer']);
    expect(responder.texts.join('\n')).not.toContain('task_');
    expect(responder.texts.join('\n')).not.toContain('任务');
    expect(
      db.getContext({ scope: 'user', roomId: 'room1', userId: 'user1', limit: 10 }).length
    ).toBe(2);
    await vi.waitFor(() =>
      expect(db.getContext({ scope: 'room', roomId: 'room1', limit: 10 })).toHaveLength(2)
    );
    expect(
      db.getContext({ scope: 'room', roomId: 'room1', limit: 10 }).map((turn) => turn.content)
    ).toEqual(['User One @DangBot: 解释 TypeScript strict mode', 'DangBot: mock answer']);
    expect(chatCalls.at(-1)?.[0]?.content).toContain('当前北京时间');
    expect(chatCalls.at(-1)?.[0]?.content).toContain('相对时间');
    expect(chatOptions.at(-1)).toMatchObject({ temperature: 0.55 });
  });

  it('normalizes model Markdown before replying and storing context', async () => {
    const { router, db } = await setup({
      enabled: true,
      chat: async () =>
        [
          '# 结论',
          '',
          '**可以**这样做',
          '',
          '- 第一步',
          '- 第二步',
          '[参考](https://example.test)'
        ].join('\n')
    });
    const responder = new MemoryResponder();

    await router.handleMessage(
      message({ mentioned: true, mentionText: '给我一个方案' }),
      responder
    );

    const expected = [
      '结论',
      '',
      '可以这样做',
      '',
      '1、第一步',
      '2、第二步',
      '参考 https://example.test'
    ].join('\n');
    await vi.waitFor(() => expect(responder.texts).toContain(expected));
    expect(responder.texts.join('\n')).not.toContain('# ');
    expect(responder.texts.join('\n')).not.toContain('**');
    expect(responder.texts.join('\n')).not.toContain('- ');
    expect(
      db.getContext({ scope: 'user', roomId: 'room1', userId: 'user1', limit: 10 }).at(-1)?.content
    ).toBe(expected);
  });

  it('injects recent public room context into later user requests', async () => {
    const { router, chatCalls } = await setup({ enabled: true });
    const responder = new MemoryResponder();

    await router.handleMessage(
      message({
        senderId: 'user1',
        senderName: 'User One',
        mentioned: true,
        mentionText: '先解释 A 方案'
      }),
      responder
    );
    await vi.waitFor(() => expect(responder.texts).toContain('mock answer'));

    await router.handleMessage(
      message({
        senderId: 'user2',
        senderName: 'User Two',
        mentioned: true,
        mentionText: '刚才他说的方案有什么问题？'
      }),
      responder
    );
    await vi.waitFor(() => expect(chatCalls.length).toBe(2));

    const roomContextTurn = chatCalls
      .at(-1)
      ?.find((turn) => turn.content.includes('近期群聊公共上下文'));
    expect(roomContextTurn?.content).toContain('User One @DangBot: 先解释 A 方案');
    expect(roomContextTurn?.content).toContain('DangBot: mock answer');
  });

  it('creates approval task for high risk prompts', async () => {
    const { router, db } = await setup({ enabled: true });
    const responder = new MemoryResponder();

    await router.handleMessage(
      message({ mentioned: true, mentionText: '批量发送这段内容到所有群' }),
      responder
    );

    expect(responder.texts.at(-1)).toContain('管理员点头');
    expect(db.listRoomTasks('room1', 1)[0]?.status).toBe('waiting_approval');
  });

  it('does not require approval in adminless mode', async () => {
    const { router, db } = await setup({ enabled: true, adminless: true });
    const responder = new MemoryResponder();

    await router.handleMessage(
      message({ mentioned: true, mentionText: '批量发送这段内容到所有群' }),
      responder
    );

    await vi.waitFor(() => expect(responder.texts).toContain('mock answer'));
    expect(db.listRoomTasks('room1', 1)[0]?.status).toBe('completed');
  });

  it('stores persistent memories and injects them into later requests', async () => {
    const { router, db, chatCalls } = await setup({ enabled: true });
    const responder = new MemoryResponder();

    await router.handleMessage(
      message({ mentioned: true, mentionText: '记住 我喜欢短回答' }),
      responder
    );
    await router.handleMessage(
      message({
        senderId: 'admin',
        senderName: 'Admin',
        mentioned: true,
        mentionText: '全局记住 默认使用中文'
      }),
      responder
    );
    await router.handleMessage(message({ mentioned: true, mentionText: '我的记忆' }), responder);
    await router.handleMessage(
      message({ mentioned: true, mentionText: '你记得什么？' }),
      responder
    );

    await vi.waitFor(() => expect(responder.texts).toContain('mock answer'));
    expect(responder.texts.join('\n')).toContain('我喜欢短回答');
    expect(responder.texts.join('\n')).toContain('1、我喜欢短回答');
    expect(responder.texts.join('\n')).not.toContain('\n- ');
    expect(
      db.listMemories({ scope: 'user', roomId: 'room1', userId: 'user1', limit: 10 })
    ).toHaveLength(1);
    const latestSystemPrompt = chatCalls.at(-1)?.[0]?.content ?? '';
    expect(latestSystemPrompt).toContain('我喜欢短回答');
    expect(latestSystemPrompt).toContain('默认使用中文');
  });

  it('delivers image, voice, and video generation results as supported media', async () => {
    const { router, db, voiceCalls } = await setup({ enabled: true, adminless: true });
    const responder = new MemoryResponder();

    await router.handleMessage(
      message({ mentioned: true, mentionText: '生成图片：一只猫趴在窗台上' }),
      responder
    );
    await vi.waitFor(() => expect(responder.images).toContain('/tmp/mock.png'));

    await router.handleMessage(
      message({ mentioned: true, mentionText: '生成语音：今天也要开心呀' }),
      responder
    );
    await vi.waitFor(() => expect(responder.files).toContain('/tmp/mock.mp3'));
    expect(voiceCalls).toEqual(['今天也要开心呀']);

    await router.handleMessage(
      message({ mentioned: true, mentionText: '生成视频：一只猫慢慢伸懒腰' }),
      responder
    );
    await vi.waitFor(() => expect(responder.files).toContain('/tmp/mock.mp4'));

    const tasks = db.listRoomTasks('room1', 10);
    expect(
      tasks.some((task) => task.requestType === 'image_generation' && task.resultKind === 'image')
    ).toBe(true);
    expect(
      tasks.some((task) => task.requestType === 'voice_generation' && task.resultKind === 'file')
    ).toBe(true);
    expect(
      tasks.some((task) => task.requestType === 'video_generation' && task.resultKind === 'file')
    ).toBe(true);
    const imageTask = tasks.find((task) => task.requestType === 'image_generation');
    const voiceTask = tasks.find((task) => task.requestType === 'voice_generation');
    const videoTask = tasks.find((task) => task.requestType === 'video_generation');
    expect(imageTask ? db.listTaskToolCalls(imageTask.id).at(0) : undefined).toMatchObject({
      toolName: 'image.generate',
      status: 'completed'
    });
    expect(voiceTask ? db.listTaskToolCalls(voiceTask.id).at(0) : undefined).toMatchObject({
      toolName: 'voice.generate',
      status: 'completed'
    });
    expect(videoTask ? db.listTaskToolCalls(videoTask.id).at(0) : undefined).toMatchObject({
      toolName: 'video.generate',
      status: 'completed'
    });
  });

  it('requires approval for high-risk tools when approvers exist', async () => {
    const { router, db } = await setup({ enabled: true });
    const responder = new MemoryResponder();

    await router.handleMessage(
      message({ mentioned: true, mentionText: '生成视频：一只猫慢慢伸懒腰' }),
      responder
    );

    expect(responder.texts.at(-1)).toContain('管理员点头');
    expect(db.listRoomTasks('room1', 1)[0]).toMatchObject({
      requestType: 'video_generation',
      toolName: 'video.generate',
      status: 'waiting_approval'
    });
  });

  it('runs voice generation through the normal file delivery path', async () => {
    const { router, db, voiceCalls } = await setup({ enabled: true, adminless: true });
    const responder = new MemoryResponder();

    await router.handleMessage(
      message({ mentioned: true, mentionText: '生成语音：请作为文件发送' }),
      responder
    );

    await vi.waitFor(() => expect(responder.files).toContain('/tmp/mock.mp3'));
    expect(responder.texts).toEqual(['好哒，我这就伸爪把它合成语音文件发你，喵～']);
    expect(voiceCalls).toEqual(['请作为文件发送']);
    expect(db.listRoomTasks('room1', 1)[0]).toMatchObject({
      requestType: 'voice_generation',
      resultKind: 'file',
      resultPath: '/tmp/mock.mp3',
      status: 'completed'
    });
  });

  it('resolves a named work before synthesizing only its full text', async () => {
    const fullText =
      '豫章故郡，洪都新府。星分翼轸，地接衡庐。襟三江而带五湖，控蛮荆而引瓯越。时维九月，序属三秋。潦水尽而寒潭清，烟光凝而暮山紫。';
    const searchMaterial = `${fullText}\n\n滕王阁诗\n滕王高阁临江渚，佩玉鸣鸾罢歌舞。`;
    const { router, db, voiceCalls, searchCalls, agentCalls } = await setup({
      enabled: true,
      adminless: true,
      searchEnabled: true,
      webSearchAnswer: searchMaterial,
      agent: (messages) => {
        const state = messages.at(-1)?.content ?? '';
        if (state.includes('工具：voice.generate')) {
          return '{"action":"finish","result":"last_tool"}';
        }
        if (state.includes('工具：text.prepare')) {
          expect(state).toContain(`"content":"${fullText}"`);
          return JSON.stringify({
            action: 'tool',
            toolName: 'voice.generate',
            input: { text: fullText },
            reason: '净化后的文本只有指定作品正文'
          });
        }
        if (state.includes('工具：web.search')) {
          return JSON.stringify({
            action: 'tool',
            toolName: 'text.prepare',
            input: {
              instruction:
                '只保留《滕王阁序》正文，去掉标题、注释、译文、来源以及后面的《滕王阁诗》',
              source: searchMaterial,
              startMarker: '豫章故郡，洪都新府。',
              endMarker: '潦水尽而寒潭清，烟光凝而暮山紫。'
            },
            reason: '搜索材料混有相邻作品，需要先提取正文'
          });
        }
        return JSON.stringify({
          action: 'tool',
          toolName: 'web.search',
          input: {
            prompt: '查找《滕王阁序》完整原文，只返回正文，不要标题、注释、译文或来源',
            query: '滕王阁序 完整原文'
          },
          reason: '用户只给了作品名，需要先取得正文'
        });
      }
    });
    const responder = new MemoryResponder();

    await router.handleMessage(
      message({ mentioned: true, mentionText: '朗读一下滕王阁序' }),
      responder
    );

    await vi.waitFor(() => expect(responder.files).toContain('/tmp/mock.mp3'));
    expect(searchCalls).toHaveLength(1);
    expect(voiceCalls).toEqual([fullText]);
    expect(voiceCalls[0]).not.toContain('朗读');
    expect(voiceCalls[0]).not.toContain('一下');
    expect(voiceCalls[0]).not.toContain('《滕王阁序》');
    expect(voiceCalls[0]).not.toContain('滕王阁诗');
    expect(agentCalls).toHaveLength(3);
    expect(db.listRoomTasks('room1', 1)[0]).toMatchObject({
      requestType: 'voice_generation',
      resultKind: 'file',
      status: 'completed'
    });
    expect(db.listTaskToolCalls(db.listRoomTasks('room1', 1)[0]!.id)).toMatchObject([
      { toolName: 'web.search', status: 'completed' },
      { toolName: 'text.prepare', status: 'completed' },
      { toolName: 'voice.generate', status: 'completed' }
    ]);
  });

  it('refuses to send a named-work placeholder directly to TTS', async () => {
    const { router, db, voiceCalls } = await setup({
      enabled: true,
      adminless: true,
      agent: () =>
        JSON.stringify({
          action: 'tool',
          toolName: 'voice.generate',
          input: { text: '《滕王阁序》' }
        })
    });
    const responder = new MemoryResponder();

    await router.handleMessage(
      message({ mentioned: true, mentionText: '朗读一下《滕王阁序》' }),
      responder
    );

    await vi.waitFor(() => expect(db.listRoomTasks('room1', 1)[0]?.status).toBe('failed'));
    expect(voiceCalls).toEqual([]);
    expect(db.listRoomTasks('room1', 1)[0]?.error).toContain('作品名而不是正文');
  });

  it('stops an agent that repeats the same tool call', async () => {
    const repeatedSearch = JSON.stringify({
      action: 'tool',
      toolName: 'web.search',
      input: {
        prompt: '查找《滕王阁序》完整原文，只返回正文',
        query: '滕王阁序 完整原文'
      }
    });
    const { router, db, searchCalls } = await setup({
      enabled: true,
      adminless: true,
      searchEnabled: true,
      agent: () => repeatedSearch
    });
    const responder = new MemoryResponder();

    await router.handleMessage(
      message({ mentioned: true, mentionText: '朗读一下《滕王阁序》' }),
      responder
    );

    await vi.waitFor(() => expect(db.listRoomTasks('room1', 1)[0]?.status).toBe('failed'));
    expect(searchCalls).toHaveLength(1);
    expect(db.listRoomTasks('room1', 1)[0]?.error).toContain('重复调用了相同工具');
  });

  it('does not finish a voice task before the target TTS tool runs', async () => {
    const preparedText = '豫章故郡，洪都新府。请洒潘江，各倾陆海云尔。';
    const { router, db, voiceCalls, agentCalls } = await setup({
      enabled: true,
      adminless: true,
      searchEnabled: true,
      agent: (messages) => {
        const state = messages.at(-1)?.content ?? '';
        if (state.includes('任务尚未完成：最终必须调用目标工具 voice.generate')) {
          return JSON.stringify({
            action: 'tool',
            toolName: 'voice.generate',
            input: { text: preparedText }
          });
        }
        if (state.includes('工具：text.prepare')) {
          return '{"action":"finish","result":"last_tool"}';
        }
        if (state.includes('工具：web.search')) {
          return JSON.stringify({
            action: 'tool',
            toolName: 'text.prepare',
            input: {
              instruction: '只提取正文',
              source: preparedText,
              startMarker: '豫章故郡，洪都新府。',
              endMarker: '请洒潘江，各倾陆海云尔。'
            }
          });
        }
        return JSON.stringify({
          action: 'tool',
          toolName: 'web.search',
          input: { prompt: '只返回正文', query: '滕王阁序 原文' }
        });
      }
    });
    const responder = new MemoryResponder();

    await router.handleMessage(
      message({ mentioned: true, mentionText: '朗读一下滕王阁序' }),
      responder
    );

    await vi.waitFor(() => expect(responder.files).toContain('/tmp/mock.mp3'));
    expect(voiceCalls).toEqual([preparedText]);
    expect(agentCalls).toHaveLength(4);
    expect(db.listRoomTasks('room1', 1)[0]?.status).toBe('completed');
  });

  it('denies disabled tools before creating tasks', async () => {
    const { router, db } = await setup({
      enabled: true,
      searchEnabled: true,
      denyTools: ['web.search']
    });
    const responder = new MemoryResponder();

    await router.handleMessage(
      message({ mentioned: true, mentionText: '联网搜索 Qwen 最新消息' }),
      responder
    );

    expect(responder.texts.at(-1)).toContain('我不能执行');
    expect(db.listRoomTasks('room1')).toEqual([]);
  });

  it('runs web search requests through OpenRouter web search and returns sources', async () => {
    const { router, searchCalls } = await setup({ enabled: true, searchEnabled: true });
    const responder = new MemoryResponder();

    await router.handleMessage(
      message({ mentioned: true, mentionText: '联网搜索 Qwen 最新消息' }),
      responder
    );

    await vi.waitFor(() =>
      expect(responder.texts).toContain(
        'mock search answer\n\n来源 1：Qwen news https://example.test/qwen'
      )
    );
    expect(searchCalls).toHaveLength(1);
    expect(searchCalls[0]?.content).toContain('实际搜索词：Qwen 最新消息');
    expect(searchCalls[0]?.content).toMatch(/实际搜索词：Qwen 最新消息 \d{4}-\d{2}-\d{2} 北京时间/);
    expect(searchCalls[0]?.content).toContain('当前北京时间');
    expect(searchCalls[0]?.content).toContain('不要把过期网页里的“今天”当成真正的今天');
    expect(searchCalls[0]?.options).toMatchObject({ maxResults: 5, searchContextSize: 'medium' });
  });

  it('strips polite search command words without leaking filler into the query', async () => {
    const { router, searchCalls } = await setup({ enabled: true, searchEnabled: true });
    const responder = new MemoryResponder();

    await router.handleMessage(
      message({ mentioned: true, mentionText: '搜索一下2025年的杭州前八所中考分数线' }),
      responder
    );

    await vi.waitFor(() => expect(searchCalls).toHaveLength(1));
    expect(searchCalls[0]?.content).toContain('实际搜索词：2025年的杭州前八所中考分数线');
    expect(searchCalls[0]?.content).not.toContain('实际搜索词：一下2025年的杭州前八所中考分数线');
    expect(responder.texts).toContain('这一步处理完啦：搜索词捋好啦：2025年的杭州前八所中考分数线');
  });

  it('treats current exam schedules as stepped web search instead of plain qa', async () => {
    const { router, searchCalls } = await setup({ enabled: true, searchEnabled: true });
    const responder = new MemoryResponder();

    await router.handleMessage(
      message({ mentioned: true, mentionText: '帮我看一下今年杭州的高考日程' }),
      responder
    );

    await vi.waitFor(() => expect(searchCalls).toHaveLength(1));
    expect(searchCalls[0]?.content).toMatch(
      /实际搜索词：今年杭州的高考日程 \d{4}-\d{2}-\d{2} 北京时间/
    );
    expect(searchCalls[0]?.content).not.toContain('实际搜索词：帮我看一下');
    expect(responder.texts.at(0)).toBe('收到，我先扒拉一下。');
    expect(responder.texts.join('\n')).toContain('搜索词捋好啦：今年杭州的高考日程');
    expect(responder.texts).toContain('完成啦，结果在下面。');
  });

  it('sends persona-friendly step updates for task requests', async () => {
    const { router } = await setup({ enabled: true, searchEnabled: true });
    const responder = new MemoryResponder();

    await router.handleMessage(
      message({ mentioned: true, mentionText: '联网搜索 Qwen 最新消息' }),
      responder
    );

    await vi.waitFor(() =>
      expect(responder.texts).toContain(
        'mock search answer\n\n来源 1：Qwen news https://example.test/qwen'
      )
    );
    expect(responder.texts.at(0)).toBe('收到，我先扒拉一下。');
    expect(responder.texts.at(1)).toContain('我打算先把搜索词捋准');
    expect(responder.texts).toContain('完成啦，结果在下面。');
    expect(responder.texts.join('\n')).toContain('这一步处理完啦');
    expect(responder.texts.join('\n')).not.toContain('系统');
    expect(responder.texts.join('\n')).not.toContain('```');
    expect(responder.texts.join('\n')).not.toContain('- ');
  });

  it('keeps task execution going when a progress reply fails', async () => {
    const { router, searchCalls } = await setup({ enabled: true, searchEnabled: true });
    const responder = new FailingMemoryResponder({ failTextAt: 1 });

    await router.handleMessage(
      message({ mentioned: true, mentionText: '联网搜索 Qwen 最新消息' }),
      responder
    );

    await vi.waitFor(() => expect(searchCalls).toHaveLength(1));
    await vi.waitFor(() =>
      expect(responder.texts).toContain(
        'mock search answer\n\n来源 1：Qwen news https://example.test/qwen'
      )
    );
  });

  it('falls back to a local persona plan when LLM planning fails', async () => {
    const filePath = await tempFile('notes.txt', '这里是文件内容');
    const { router, chatCalls } = await setup({
      enabled: true,
      chat: async (messages) => {
        if (messages.at(-1)?.content.includes('请用 2 到 4 行说明你打算怎么做')) {
          throw new Error('plan failed');
        }
        return 'file answer';
      }
    });
    const responder = new MemoryResponder();

    await router.handleMessage(
      message({
        mentioned: true,
        mentionText: '总结刚才的文件',
        attachments: [attachment(filePath, 'notes.txt', 'text/plain', 'file')]
      }),
      responder
    );

    await vi.waitFor(() => expect(responder.texts).toContain('file answer'));
    expect(chatCalls).toHaveLength(2);
    expect(responder.texts.at(0)).toBe('收到，我先扒拉一下。');
    expect(responder.texts.at(1)).toContain('我打算先把文件内容读出来');
    expect(responder.texts).toContain('这一步处理完啦：文件内容已经读出来啦。');
    expect(responder.texts).toContain('完成啦，结果在下面。');
  });

  it('does not load attachments for unauthorized rooms or non-normal commands', async () => {
    const { router } = await setup({ enabled: false });
    const responder = new MemoryResponder();
    const loadUnauthorized = vi.fn(async () => []);
    const loadStatus = vi.fn(async () => []);

    await router.handleMessage(
      message({
        roomId: 'other-room',
        roomTopic: '其他群',
        mentioned: true,
        mentionText: '状态',
        loadAttachments: loadUnauthorized
      }),
      responder
    );
    await router.handleMessage(
      message({ mentioned: true, mentionText: '状态', loadAttachments: loadStatus }),
      responder
    );

    expect(loadUnauthorized).not.toHaveBeenCalled();
    expect(loadStatus).not.toHaveBeenCalled();
  });

  it('aborts a running task when an admin cancels it', async () => {
    let aborted = false;
    const { router, db } = await setup({
      enabled: true,
      chat: async (_messages, signal) =>
        new Promise<string>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new Error('aborted'));
            },
            { once: true }
          );
        })
    });
    const responder = new MemoryResponder();

    await router.handleMessage(
      message({ mentioned: true, mentionText: '解释一个慢任务' }),
      responder
    );
    await vi.waitFor(() => expect(db.listRoomTasks('room1', 1)[0]?.status).toBe('processing'));
    await router.handleMessage(
      message({ senderId: 'admin', senderName: 'Admin', mentioned: true, mentionText: '取消' }),
      responder
    );

    await vi.waitFor(() => expect(aborted).toBe(true));
    expect(db.listRoomTasks('room1', 1)[0]?.status).toBe('cancelled');
    expect(responder.texts).not.toContain('处理失败：aborted');
  });

  it('uses the originally attached file after approval', async () => {
    const firstImage = await tempFile('first.png', 'first-image');
    const secondImage = await tempFile('second.png', 'second-image');
    const { router, videoCalls } = await setup({ enabled: true });
    const responder = new MemoryResponder();

    await router.handleMessage(
      message({
        mentioned: true,
        mentionText: '批量发送，把这张图动起来',
        attachments: [attachment(firstImage, 'first.png', 'image/png', 'image')]
      }),
      responder
    );
    await router.handleMessage(
      message({
        mentioned: false,
        text: '',
        attachments: [attachment(secondImage, 'second.png', 'image/png', 'image')]
      }),
      responder
    );
    await router.handleMessage(
      message({ senderId: 'admin', senderName: 'Admin', mentioned: true, mentionText: '同意' }),
      responder
    );

    await vi.waitFor(() => expect(videoCalls.at(-1)?.frameImagePath).toBe(firstImage));
    expect(responder.texts.at(0)).toContain('管理员点头');
    expect(responder.texts).not.toContain('收到，我先扒拉一下。');
    expect(responder.texts).toContain('好，我开始处理。');
    expect(responder.texts.some((text) => text.includes('我打算先拿参考图当首帧'))).toBe(true);
    expect(responder.texts).toContain('完成啦，结果文件发你。');
  });

  it('does not send failed progress when a task-like request is cancelled', async () => {
    const filePath = await tempFile('slow.txt', '慢文件');
    let aborted = false;
    let actualStarted = false;
    const { router, db } = await setup({
      enabled: true,
      chat: async (messages, signal) => {
        if (messages.at(-1)?.content.includes('请用 2 到 4 行说明你打算怎么做')) {
          return '我打算先读文件，再慢慢捋结果。';
        }
        actualStarted = true;
        return new Promise<string>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new Error('aborted'));
            },
            { once: true }
          );
        });
      }
    });
    const responder = new MemoryResponder();

    await router.handleMessage(
      message({
        mentioned: true,
        mentionText: '总结刚才的文件',
        attachments: [attachment(filePath, 'slow.txt', 'text/plain', 'file')]
      }),
      responder
    );
    await vi.waitFor(() => expect(db.listRoomTasks('room1', 1)[0]?.status).toBe('processing'));
    await vi.waitFor(() => expect(actualStarted).toBe(true));
    await router.handleMessage(
      message({ senderId: 'admin', senderName: 'Admin', mentioned: true, mentionText: '取消' }),
      responder
    );

    await vi.waitFor(() => expect(aborted).toBe(true));
    expect(responder.texts.join('\n')).not.toContain('这次没处理成');
  });

  it('does not continue into task execution after cancellation aborts planning', async () => {
    const filePath = await tempFile('plan-slow.txt', '慢文件');
    let planStarted = false;
    let actualStarted = false;
    const { router, db } = await setup({
      enabled: true,
      chat: async (messages, signal) => {
        if (messages.at(-1)?.content.includes('请用 2 到 4 行说明你打算怎么做')) {
          planStarted = true;
          return new Promise<string>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted plan')), {
              once: true
            });
          });
        }
        actualStarted = true;
        return 'should not run';
      }
    });
    const responder = new MemoryResponder();

    await router.handleMessage(
      message({
        mentioned: true,
        mentionText: '总结刚才的文件',
        attachments: [attachment(filePath, 'plan-slow.txt', 'text/plain', 'file')]
      }),
      responder
    );
    await vi.waitFor(() => expect(planStarted).toBe(true));
    await router.handleMessage(
      message({ senderId: 'admin', senderName: 'Admin', mentioned: true, mentionText: '取消' }),
      responder
    );

    await vi.waitFor(() => expect(db.listRoomTasks('room1', 1)[0]?.status).toBe('cancelled'));
    expect(actualStarted).toBe(false);
    expect(responder.texts.join('\n')).not.toContain('should not run');
    expect(responder.texts.join('\n')).not.toContain('这次没处理成');
  });

  it('writes long text results as txt files with plain content', async () => {
    const { router } = await setup({
      enabled: true,
      maxReplyTextChars: 20,
      chat: async () => ['# 长结果', '', '- 第一段内容很长', '- 第二段内容也很长'].join('\n')
    });
    const responder = new MemoryResponder();

    await router.handleMessage(message({ mentioned: true, mentionText: '给我长一点' }), responder);

    await vi.waitFor(() => expect(responder.files).toHaveLength(1));
    expect(responder.texts).toContain('内容有点长，我放成文本文件发你。');
    const filePath = responder.files.at(-1);
    expect(filePath).toMatch(/\.txt$/);
    expect(filePath).not.toMatch(/\.md$/);
    if (!filePath) throw new Error('missing long text result file');
    const content = await readFile(filePath, 'utf8');
    expect(content).toBe(['长结果', '', '1、第一段内容很长', '2、第二段内容也很长'].join('\n'));
  });

  it('creates and manages automations through admin commands', async () => {
    const { router, db } = await setup({ enabled: true });
    const responder = new MemoryResponder();

    await router.handleMessage(
      message({
        senderId: 'admin',
        senderName: 'Admin',
        mentioned: true,
        mentionText: '提醒我 10分钟后 喝水',
        timestamp: new Date('2026-06-05T01:30:00.000Z')
      }),
      responder
    );

    const automation = db.listRoomAutomations('room1', 1)[0];
    expect(automation).toMatchObject({
      kind: 'reminder',
      prompt: '喝水',
      status: 'active',
      nextRunAt: '2026-06-05T01:40:00.000Z'
    });
    expect(responder.texts.at(-1)).toContain('记好啦，喵。');
    expect(responder.texts.at(-1)).toContain('小提醒：喝水');
    expect(responder.texts.at(-1)).toContain('下次我会在：2026-06-05 09:40');
    expect(responder.texts.at(-1)).not.toContain(automation!.id);
    expect(responder.texts.at(-1)).not.toContain('T01:40:00.000Z');

    await router.handleMessage(
      message({ senderId: 'admin', senderName: 'Admin', mentioned: true, mentionText: '自动化列表' }),
      responder
    );
    expect(responder.texts.at(-1)).toContain('小当的小闹钟');
    expect(responder.texts.at(-1)).toContain('小提醒');
    expect(responder.texts.at(-1)).not.toContain(automation!.id);

    await router.handleMessage(
      message({
        senderId: 'admin',
        senderName: 'Admin',
        mentioned: true,
        mentionText: '暂停第1个'
      }),
      responder
    );
    expect(db.getAutomation(automation!.id)?.status).toBe('paused');
    expect(responder.texts.at(-1)).toContain('把这只小闹钟按住了');
    expect(responder.texts.at(-1)).not.toContain(automation!.id);

    await router.handleMessage(
      message({
        senderId: 'admin',
        senderName: 'Admin',
        mentioned: true,
        mentionText: '恢复第1个'
      }),
      responder
    );
    expect(db.getAutomation(automation!.id)?.status).toBe('active');
    expect(responder.texts.at(-1)).toContain('把这只小闹钟叫醒了');
    expect(responder.texts.at(-1)).toContain('下次我会在：');
    expect(responder.texts.at(-1)).not.toContain(automation!.id);
    expect(responder.texts.at(-1)).not.toContain('T');

    await router.handleMessage(
      message({
        senderId: 'admin',
        senderName: 'Admin',
        mentioned: true,
        mentionText: '删除第1个'
      }),
      responder
    );
    expect(db.getAutomation(automation!.id)).toBeUndefined();
    expect(responder.texts.at(-1)).toContain('叼走啦');
    expect(responder.texts.at(-1)).not.toContain(automation!.id);
  });

  it('allows members to create automations in adminless mode', async () => {
    const { router, db } = await setup({ enabled: true, adminless: true });
    const responder = new MemoryResponder();

    await router.handleMessage(
      message({
        mentioned: true,
        mentionText: '设置定时任务 每天 09:00 总结群聊',
        timestamp: new Date('2026-06-05T01:30:00.000Z')
      }),
      responder
    );

    const automation = db.listRoomAutomations('room1', 1)[0];
    expect(automation).toMatchObject({
      kind: 'scheduled_prompt',
      scheduleType: 'daily',
      prompt: '总结群聊',
      status: 'active'
    });
    expect(responder.texts.at(-1)).toContain('记好啦，喵。');
    expect(responder.texts.at(-1)).toContain('定时小爪：总结群聊');
    expect(responder.texts.at(-1)).not.toContain(automation!.id);
  });

  it('creates automations when the command prefix is followed by a Chinese comma', async () => {
    const { router, db } = await setup({ enabled: true, adminless: true });
    const responder = new MemoryResponder();

    await router.handleMessage(
      message({
        mentioned: true,
        mentionText: '设置定时任务，每天下午六点提醒我去锻炼',
        timestamp: new Date('2026-06-05T16:30:00.000Z')
      }),
      responder
    );

    const automation = db.listRoomAutomations('room1', 1)[0];
    expect(automation).toMatchObject({
      kind: 'reminder',
      scheduleType: 'daily',
      prompt: '去锻炼',
      nextRunAt: '2026-06-06T10:00:00.000Z'
    });
    expect(responder.texts.at(-1)).toContain('下次我会在：2026-06-06 18:00');
    expect(responder.texts.at(-1)).not.toContain(automation!.id);
    expect(responder.texts.at(-1)).not.toContain('T10:00:00.000Z');
  });

  it('runs reminder and scheduled prompt automations', async () => {
    const { router, db } = await setup({ enabled: true });
    const reminderResponder = new MemoryResponder();
    const taskResponder = new MemoryResponder();

    const reminder = db.createAutomation({
      roomId: 'room1',
      creatorId: 'admin',
      name: '提醒:喝水',
      kind: 'reminder',
      requestType: 'qa',
      scheduleType: 'once',
      scheduleSpecJson: JSON.stringify({
        type: 'once',
        at: '2026-06-05T01:40:00.000Z',
        label: '10分钟后'
      }),
      timezone: 'Asia/Shanghai',
      prompt: '喝水',
      nextRunAt: '2026-06-05T01:40:00.000Z'
    });
    await router.handleAutomationTrigger(reminder, reminderResponder);
    expect(reminderResponder.texts).toEqual(['提醒：喝水']);
    expect(db.listRoomTasks('room1')).toEqual([]);

    const scheduled = db.createAutomation({
      roomId: 'room1',
      creatorId: 'admin',
      name: '定时任务:报个状态',
      kind: 'scheduled_prompt',
      requestType: 'qa',
      scheduleType: 'once',
      scheduleSpecJson: JSON.stringify({
        type: 'once',
        at: '2026-06-05T01:40:00.000Z',
        label: '10分钟后'
      }),
      timezone: 'Asia/Shanghai',
      prompt: '报个状态',
      nextRunAt: '2026-06-05T01:40:00.000Z'
    });
    await router.handleAutomationTrigger(scheduled, taskResponder);
    await vi.waitFor(() => expect(taskResponder.texts).toContain('mock answer'));
    expect(db.listRoomTasks('room1', 1)[0]).toMatchObject({
      requestType: 'qa',
      status: 'completed'
    });
  });

  it('does not report a scheduled task as successful when its tool fails', async () => {
    const { router, db } = await setup({
      enabled: true,
      generateVoice: async () => {
        throw new Error('speech failed');
      }
    });
    const responder = new MemoryResponder();
    const automation = db.createAutomation({
      roomId: 'room1',
      creatorId: 'admin',
      name: '语音失败测试',
      kind: 'scheduled_prompt',
      requestType: 'voice_generation',
      scheduleType: 'once',
      scheduleSpecJson: JSON.stringify({
        type: 'once',
        at: '2026-06-05T01:40:00.000Z',
        label: '立即'
      }),
      timezone: 'Asia/Shanghai',
      prompt: '生成语音：测试',
      toolName: 'voice.generate',
      toolInputJson: JSON.stringify({ text: '测试' }),
      nextRunAt: '2026-06-05T01:40:00.000Z'
    });

    await expect(router.handleAutomationTrigger(automation, responder)).rejects.toThrow(
      'speech failed'
    );
    expect(db.listRoomTasks('room1', 1)[0]).toMatchObject({
      requestType: 'voice_generation',
      status: 'failed',
      error: 'speech failed'
    });
  });
});

async function setup(
  options: {
    enabled?: boolean;
    adminless?: boolean;
    chat?: (
      messages: Array<{ role: string; content: string }>,
      signal?: AbortSignal,
      options?: { temperature?: number }
    ) => Promise<string>;
    agent?: (messages: Array<{ role: string; content: string }>) => Promise<string> | string;
    intent?: RequestKind | ((classificationPrompt: string) => RequestKind);
    generateVoice?: (text: string) => Promise<{ filePath: string }>;
    webSearchAnswer?: string;
    searchEnabled?: boolean;
    maxReplyTextChars?: number;
    denyTools?: string[];
  } = {}
) {
  const admins = options.adminless ? [] : ['admin'];
  const config = await makeTestConfig({
    search: {
      enabled: options.searchEnabled ?? false,
      provider: 'openrouter'
    },
    limits: {
      maxReplyTextChars: options.maxReplyTextChars ?? 1800
    },
    tools: {
      policy: {
        denyTools: options.denyTools ?? []
      }
    },
    auth: {
      systemAdmins: options.adminless ? [] : ['sys'],
      rooms: [{ id: 'room1', topic: '测试群', enabled: options.enabled ?? false, admins }]
    }
  });
  const db = AppDatabase.memory();
  db.seedConfig(config);
  const logger = silentLogger();
  const queue = new TaskQueue(db, logger, {
    maxConcurrentTasks: 2,
    maxConcurrentLongTasks: 1,
    taskTimeoutMs: 5000
  });
  const chatCalls: Array<Array<{ role: string; content: string }>> = [];
  const chatOptions: Array<{ temperature?: number } | undefined> = [];
  const intentCalls: Array<Array<{ role: string; content: string }>> = [];
  const agentCalls: Array<Array<{ role: string; content: string }>> = [];
  const automationCalls: Array<Array<{ role: string; content: string }>> = [];
  const videoCalls: Array<{ frameImagePath?: string }> = [];
  const voiceCalls: string[] = [];
  const searchCalls: Array<{
    content: string;
    options: { maxResults: number; searchContextSize: string };
  }> = [];
  const llm = {
    configured: () => true,
    speechConfigured: () => true,
    chat: async (
      messages: Array<{ role: string; content: string }>,
      signal?: AbortSignal,
      chatOption?: { temperature?: number }
    ) => {
      if (isIntentClassificationCall(messages)) {
        intentCalls.push(messages);
        return JSON.stringify({
          requestType:
            typeof options.intent === 'function'
              ? options.intent(messages.at(-1)?.content ?? '')
              : (options.intent ?? classifyIntentForRouterTest(messages.at(-1)?.content ?? ''))
        });
      }

      if (isAutomationDefinitionCall(messages)) {
        automationCalls.push(messages);
        return automationDefinitionForRouterTest(messages.at(-1)?.content ?? '');
      }

      if (isTaskAgentCall(messages)) {
        agentCalls.push(messages);
        if (options.agent) return options.agent(messages);
        return defaultAgentDecision(messages);
      }

      chatCalls.push(messages);
      chatOptions.push(chatOption);
      if (options.chat) return options.chat(messages, signal, chatOption);
      return 'mock answer';
    },
    vision: async () => 'mock vision',
    video: async () => 'mock video',
    generateImage: async () => '/tmp/mock.png',
    generateVoice: async (text: string) => {
      voiceCalls.push(text);
      if (options.generateVoice) return options.generateVoice(text);
      return { filePath: '/tmp/mock.mp3' };
    },
    generateVideo: async (_prompt: string, options: { frameImagePath?: string }) => {
      videoCalls.push(options);
      return '/tmp/mock.mp4';
    },
    chatWithWebSearch: async (
      messages: Array<{ role: string; content: string }>,
      webOptions: { maxResults: number; searchContextSize: 'low' | 'medium' | 'high' }
    ) => {
      searchCalls.push({ content: messages.at(-1)?.content ?? '', options: webOptions });
      if (!(webOptions.searchContextSize && webOptions.maxResults))
        throw new Error('missing search options');
      return {
        text: options.webSearchAnswer ?? 'mock search answer',
        sources: [{ title: 'Qwen news', url: 'https://example.test/qwen' }]
      };
    }
  } as unknown as OpenAICompatibleClient;
  const fileService = new FileService(config);
  const router = new BotRequestRouter(
    config,
    db,
    queue,
    llm,
    fileService,
    logger,
    undefined,
    undefined
  );
  return {
    router,
    db,
    chatCalls,
    chatOptions,
    intentCalls,
    agentCalls,
    automationCalls,
    videoCalls,
    voiceCalls,
    searchCalls
  };
}

function isIntentClassificationCall(messages: Array<{ role: string; content: string }>): boolean {
  return (
    (messages[0]?.content.includes('请求意图分类器') ?? false) &&
    (messages.at(-1)?.content.includes('请判断 requestType') ?? false)
  );
}

function isAutomationDefinitionCall(messages: Array<{ role: string; content: string }>): boolean {
  return (
    (messages[0]?.content.includes('自动化定时任务解析器') ?? false) &&
    (messages.at(-1)?.content.includes('请解析这个自动化或提醒') ?? false)
  );
}

function isTaskAgentCall(messages: Array<{ role: string; content: string }>): boolean {
  return messages[0]?.content.includes('多步工具执行器') ?? false;
}

function defaultAgentDecision(messages: Array<{ role: string; content: string }>): string {
  const content = messages.at(-1)?.content ?? '';
  if (!content.includes('已执行观察：\n暂无')) {
    return '{"action":"finish","result":"last_tool"}';
  }

  const toolName = content.match(/原单步路由建议：([^\n]+)/)?.[1]?.trim();
  const inputJson = content.match(/原单步输入：([^\n]+)/)?.[1]?.trim();
  if (!toolName || toolName === '无' || !inputJson || inputJson === '无') {
    return '{"action":"finish","result":"text","text":"mock answer"}';
  }
  return JSON.stringify({
    action: 'tool',
    toolName,
    input: JSON.parse(inputJson) as unknown
  });
}

function automationDefinitionForRouterTest(prompt: string): string {
  if (prompt.includes('设置定时任务 每天 09:00 总结群聊')) {
    return JSON.stringify({
      valid: true,
      kind: 'scheduled_prompt',
      prompt: '总结群聊',
      schedule: { type: 'daily', time: '09:00' }
    });
  }

  if (prompt.includes('设置定时任务，每天下午六点提醒我去锻炼')) {
    return JSON.stringify({
      valid: true,
      kind: 'reminder',
      prompt: '去锻炼',
      schedule: { type: 'daily', time: '18:00' }
    });
  }

  if (prompt.includes('提醒我 10分钟后 喝水')) {
    return JSON.stringify({
      valid: true,
      kind: 'reminder',
      prompt: '喝水',
      schedule: { type: 'once_relative', amount: 10, unit: 'minute' }
    });
  }

  return '{"valid":false,"reason":"not an automation"}';
}

function classifyIntentForRouterTest(classificationPrompt: string): RequestKind {
  if (
    classificationPrompt.includes('联网搜索') ||
    classificationPrompt.includes('搜索一下') ||
    classificationPrompt.includes('最新消息') ||
    classificationPrompt.includes('高考日程')
  ) {
    return 'web_search';
  }
  if (
    classificationPrompt.includes('生成视频') ||
    classificationPrompt.includes('动起来') ||
    classificationPrompt.includes('图生视频')
  ) {
    return 'video_generation';
  }
  if (classificationPrompt.includes('生成图片') || classificationPrompt.includes('画图')) {
    return 'image_generation';
  }
  if (
    classificationPrompt.includes('生成语音') ||
    classificationPrompt.includes('合成语音') ||
    classificationPrompt.includes('朗读')
  ) {
    return 'voice_generation';
  }
  if (classificationPrompt.includes('总结刚才的文件')) return 'file_analysis';
  if (classificationPrompt.includes('最近讨论总结')) return 'summary';
  if (classificationPrompt.includes('翻译')) return 'translate';
  if (classificationPrompt.includes('改写') || classificationPrompt.includes('润色')) {
    return 'rewrite';
  }
  return 'qa';
}

class FailingMemoryResponder extends MemoryResponder {
  private textCount = 0;

  constructor(private readonly options: { failTextAt?: number } = {}) {
    super();
  }

  override async replyText(text: string): Promise<void> {
    this.textCount += 1;
    if (this.options.failTextAt === this.textCount) {
      throw new Error('reply failed');
    }
    await super.replyText(text);
  }
}

function message(overrides: Partial<IncomingMessage>): IncomingMessage {
  return {
    id: `msg_${Math.random()}`,
    roomId: 'room1',
    roomTopic: '测试群',
    senderId: 'user1',
    senderName: 'User One',
    text: overrides.mentionText ?? overrides.text ?? '',
    mentioned: false,
    mentionText: '',
    attachments: [],
    timestamp: new Date(),
    ...overrides
  };
}

async function tempFile(fileName: string, content: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dangbot-router-'));
  const filePath = path.join(dir, fileName);
  await writeFile(filePath, content);
  return filePath;
}

function attachment(
  filePath: string,
  name: string,
  mimeType: string,
  kind: 'file' | 'image' | 'video'
): IncomingMessage['attachments'][number] {
  return {
    name,
    path: filePath,
    mimeType,
    sizeBytes: 1024,
    kind
  };
}
