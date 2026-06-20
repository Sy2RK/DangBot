import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import type { AppConfig, BotResponder } from '../src/types.js';

type DeepPartial<T> = {
  [Key in keyof T]?: T[Key] extends Array<infer Item>
    ? Array<DeepPartial<Item>>
    : T[Key] extends object
      ? DeepPartial<T[Key]>
      : T[Key];
};

export async function makeTestConfig(overrides: DeepPartial<AppConfig> = {}): Promise<AppConfig> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dangbot-test-'));
  const base: AppConfig = {
    bot: {
      name: 'DangBot',
      mentionAliases: ['DangBot']
    },
    wechat: {
      puppet: 'wechaty-puppet-mock',
      puppetOptions: {}
    },
    storage: {
      sqlitePath: path.join(dir, 'dangbot.sqlite'),
      uploadsDir: path.join(dir, 'uploads'),
      outputsDir: path.join(dir, 'outputs')
    },
    logging: {
      level: 'silent',
      file: path.join(dir, 'dangbot.log')
    },
    llm: {
      baseURL: 'https://example.test/v1',
      apiKey: '',
      textModel: 'test-text',
      visionModel: 'test-vision',
      imageModel: 'test-image',
      videoModel: 'test-video',
      tts: {
        enabled: false,
        baseURL: 'https://openspeech.bytedance.com/api/v3',
        apiKey: '',
        resourceId: 'seed-tts-2.0',
        voice: 'zh_male_tiancaitongsheng_uranus_bigtts',
        speechRate: 0
      }
    },
    search: {
      enabled: false,
      provider: 'openrouter',
      braveApiKey: '',
      searchContextSize: 'medium',
      count: 5,
      searchLang: 'zh-hans',
      uiLang: 'zh-CN',
      safeSearch: 'moderate',
      extraSnippets: true
    },
    tools: {
      policy: {
        defaultHighRiskRequiresApproval: true,
        allowNetworkTools: true,
        allowFileWriteTools: false,
        maxToolOutputChars: 8000,
        denyTools: [],
        roomToolOverrides: []
      }
    },
    limits: {
      userRequestsPerMinute: 6,
      roomRequestsPerMinute: 30,
      fileTasksPerMinute: 3,
      imageTasksPerMinute: 6,
      voiceTasksPerMinute: 4,
      videoTasksPerMinute: 2,
      searchTasksPerMinute: 6,
      maxAgentSteps: 8,
      agentTaskTimeoutMs: 5000,
      maxConcurrentTasks: 2,
      maxConcurrentLongTasks: 1,
      taskTimeoutMs: 5000,
      videoGenerationTimeoutMs: 5000,
      videoGenerationPollIntervalMs: 10,
      maxFileBytes: 20 * 1024 * 1024,
      maxImageBytes: 10 * 1024 * 1024,
      maxVideoBytes: 50 * 1024 * 1024,
      maxReplyTextChars: 1800,
      contextMessagesPerUser: 32,
      publicContextMessagesPerRoom: 160,
      memoryEntriesPerUser: 20,
      globalMemoryEntries: 30,
      userMemoryIdleMs: 60 * 60 * 1000,
      memoryConsolidationKeepContextMessages: 8,
      attachmentTtlHours: 24
    },
    automations: {
      enabled: true,
      tickMs: 30_000,
      timezone: 'Asia/Shanghai',
      maxConsecutiveFailures: 3
    },
    auth: {
      systemAdmins: ['sys'],
      allowTopicRoomBinding: false,
      rooms: [
        {
          id: 'room1',
          topic: '测试群',
          enabled: false,
          admins: ['admin']
        }
      ]
    }
  };

  return {
    ...base,
    ...overrides,
    bot: { ...base.bot, ...overrides.bot },
    wechat: { ...base.wechat, ...overrides.wechat },
    storage: { ...base.storage, ...overrides.storage },
    logging: { ...base.logging, ...overrides.logging },
    llm: {
      ...base.llm,
      ...overrides.llm,
      tts: { ...base.llm.tts, ...overrides.llm?.tts }
    },
    search: { ...base.search, ...overrides.search },
    tools: {
      ...base.tools,
      ...overrides.tools,
      policy: { ...base.tools.policy, ...overrides.tools?.policy }
    } as AppConfig['tools'],
    limits: { ...base.limits, ...overrides.limits },
    automations: { ...base.automations, ...overrides.automations },
    auth: { ...base.auth, ...overrides.auth } as AppConfig['auth']
  };
}

export function silentLogger() {
  return pino({ level: 'silent' });
}

export class MemoryResponder implements BotResponder {
  readonly texts: string[] = [];
  readonly files: string[] = [];
  readonly images: string[] = [];

  async replyText(text: string): Promise<void> {
    this.texts.push(text);
  }

  async replyFile(filePath: string): Promise<void> {
    this.files.push(filePath);
  }

  async replyImage(filePath: string): Promise<void> {
    this.images.push(filePath);
  }
}
