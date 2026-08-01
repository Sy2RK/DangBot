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
    agent: {
      hermes: {
        baseURL: 'http://127.0.0.1:18642',
        apiKey: '',
        sessionSecret: 'test-session-secret-that-is-not-used-outside-tests',
        model: 'deepseek-v4-flash',
        requestTimeoutMs: 5_000,
        pollIntervalMs: 10,
        maxConcurrentRuns: 2
      },
      mcp: {
        enabled: true,
        host: '127.0.0.1',
        port: 18_643,
        apiKey: 'test-mcp-key-32-characters-minimum',
        contextTtlMs: 60_000
      },
      memoryBridge: {
        baseURL: 'http://127.0.0.1:18643',
        apiKey: 'test-memory-key-32-characters-minimum'
      },
      sandbox: {
        enabled: true,
        maxExecutionMs: 500,
        memoryLimitBytes: 16 * 1024 * 1024,
        maxOutputChars: 2_000
      }
    },
    media: {
      baseURL: 'https://example.test/v1',
      nativeBaseURL: 'https://dashscope.aliyuncs.com/api/v1',
      apiKey: '',
      multimodalModel: 'qwen3.7-flash',
      imageModel: 'qwen-image-3.0-pro',
      videoModels: {
        textToVideo: 'happyhorse-1.1-t2v',
        imageToVideo: 'happyhorse-1.1-i2v',
        referenceToVideo: 'happyhorse-1.1-r2v',
        videoEdit: 'happyhorse-1.0-video-edit'
      },
      tts: {
        enabled: false,
        apiKey: '',
        model: 'qwen-audio-3.0-tts-flash',
        voice: 'longanhuan_v3.6'
      }
    },
    limits: {
      userRequestsPerMinute: 6,
      roomRequestsPerMinute: 30,
      imageTasksPerMinute: 6,
      imageGenerationTasksPerMinute: 1,
      voiceTasksPerMinute: 4,
      videoTasksPerMinute: 2,
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
      publicContextMessagesPerRoom: 160,
      memoryEntriesPerUser: 20,
      globalMemoryEntries: 30,
      attachmentTtlHours: 24,
      maxMcpOutputChars: 8_000
    },
    reflection: {
      enabled: true,
      candidateThreshold: 5,
      idleMs: 15 * 60 * 1000,
      minSessionIntervalMs: 30 * 60 * 1000,
      maxTasksPerBatch: 8,
      autoWriteConfidence: 0.95
    },
    automations: {
      enabled: true,
      tickMs: 30_000,
      timezone: 'Asia/Shanghai',
      maxConsecutiveFailures: 3,
      retryCount: 0,
      retryDelayMs: 60_000
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
    agent: {
      ...base.agent,
      ...overrides.agent,
      hermes: { ...base.agent.hermes, ...overrides.agent?.hermes },
      mcp: { ...base.agent.mcp, ...overrides.agent?.mcp },
      memoryBridge: { ...base.agent.memoryBridge, ...overrides.agent?.memoryBridge },
      sandbox: { ...base.agent.sandbox, ...overrides.agent?.sandbox }
    },
    media: {
      ...base.media,
      ...overrides.media,
      videoModels: { ...base.media.videoModels, ...overrides.media?.videoModels },
      tts: { ...base.media.tts, ...overrides.media?.tts }
    },
    limits: { ...base.limits, ...overrides.limits },
    reflection: { ...base.reflection, ...overrides.reflection },
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
