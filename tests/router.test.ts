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

  it('delivers image and video generation results', async () => {
    const { router, db } = await setup({ enabled: true, adminless: true });
    const responder = new MemoryResponder();

    await router.handleMessage(
      message({ mentioned: true, mentionText: '生成图片：一只猫趴在窗台上' }),
      responder
    );
    await vi.waitFor(() => expect(responder.images).toContain('/tmp/mock.png'));

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
      tasks.some((task) => task.requestType === 'video_generation' && task.resultKind === 'file')
    ).toBe(true);
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
    intent?: RequestKind | ((classificationPrompt: string) => RequestKind);
    searchEnabled?: boolean;
    maxReplyTextChars?: number;
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
  const videoCalls: Array<{ frameImagePath?: string }> = [];
  const searchCalls: Array<{
    content: string;
    options: { maxResults: number; searchContextSize: string };
  }> = [];
  const llm = {
    configured: () => true,
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

      chatCalls.push(messages);
      chatOptions.push(chatOption);
      if (options.chat) return options.chat(messages, signal, chatOption);
      return 'mock answer';
    },
    vision: async () => 'mock vision',
    video: async () => 'mock video',
    generateImage: async () => '/tmp/mock.png',
    generateVideo: async (_prompt: string, options: { frameImagePath?: string }) => {
      videoCalls.push(options);
      return '/tmp/mock.mp4';
    },
    chatWithWebSearch: async (
      messages: Array<{ role: string; content: string }>,
      options: { maxResults: number; searchContextSize: 'low' | 'medium' | 'high' }
    ) => {
      searchCalls.push({ content: messages.at(-1)?.content ?? '', options });
      if (!(options.searchContextSize && options.maxResults))
        throw new Error('missing search options');
      return {
        text: 'mock search answer',
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
  return { router, db, chatCalls, chatOptions, intentCalls, videoCalls, searchCalls };
}

function isIntentClassificationCall(messages: Array<{ role: string; content: string }>): boolean {
  return (
    (messages[0]?.content.includes('请求意图分类器') ?? false) &&
    (messages.at(-1)?.content.includes('请判断 requestType') ?? false)
  );
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
