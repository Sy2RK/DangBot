import { readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import type { AppConfig } from './types.js';
import { resolveFromCwd } from './utils/fs.js';

const roomConfigSchema = z.object({
  id: z.string().optional(),
  topic: z.string().optional(),
  enabled: z.boolean().default(false),
  admins: z.array(z.string()).default([])
});

const configSchema = z.object({
  bot: z.object({
    name: z.string().min(1).default('DangBot'),
    mentionAliases: z.array(z.string()).default([])
  }),
  wechat: z.object({
    puppet: z.string().min(1).default('wechaty-puppet-wechat'),
    puppetOptions: z.record(z.string(), z.unknown()).default({})
  }),
  storage: z.object({
    sqlitePath: z.string().default('data/dangbot.sqlite'),
    uploadsDir: z.string().default('data/uploads'),
    outputsDir: z.string().default('data/outputs')
  }),
  logging: z.object({
    level: z.string().default('info'),
    file: z.string().default('logs/dangbot.log')
  }),
  llm: z.object({
    baseURL: z.string().url().default('https://api.openai.com/v1'),
    apiKey: z.string().default(''),
    textModel: z.string().default('gpt-4.1-mini'),
    visionModel: z.string().default('gpt-4.1-mini'),
    imageModel: z.string().optional()
  }),
  limits: z.object({
    userRequestsPerMinute: z.number().int().positive().default(6),
    roomRequestsPerMinute: z.number().int().positive().default(30),
    fileTasksPerMinute: z.number().int().positive().default(3),
    imageTasksPerMinute: z.number().int().positive().default(6),
    videoTasksPerMinute: z.number().int().positive().default(2),
    maxConcurrentTasks: z.number().int().positive().default(2),
    maxConcurrentLongTasks: z.number().int().positive().default(1),
    taskTimeoutMs: z.number().int().positive().default(120_000),
    maxFileBytes: z.number().int().positive().default(20 * 1024 * 1024),
    maxImageBytes: z.number().int().positive().default(10 * 1024 * 1024),
    maxVideoBytes: z.number().int().positive().default(50 * 1024 * 1024),
    maxReplyTextChars: z.number().int().positive().default(1800),
    contextMessagesPerUser: z.number().int().positive().default(32),
    publicContextMessagesPerRoom: z.number().int().positive().default(160),
    memoryEntriesPerUser: z.number().int().positive().default(20),
    globalMemoryEntries: z.number().int().positive().default(30),
    userMemoryIdleMs: z.number().int().positive().default(60 * 60 * 1000),
    memoryConsolidationKeepContextMessages: z.number().int().nonnegative().default(8),
    attachmentTtlHours: z.number().int().positive().default(24)
  }),
  auth: z.object({
    systemAdmins: z.array(z.string()).default([]),
    rooms: z.array(roomConfigSchema).default([])
  })
});

function expandEnv(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g, (_match, name: string, fallback = '') => {
      return process.env[name] ?? fallback;
    });
  }

  if (Array.isArray(value)) {
    return value.map((entry) => expandEnv(entry));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, expandEnv(entry)])
    );
  }

  return value;
}

function mergeConfig(base: unknown, override: unknown): unknown {
  if (override === undefined || override === null) return base;
  if (typeof override !== 'object') return override;
  if (!base || typeof base !== 'object') return override;
  if (Array.isArray(base) || Array.isArray(override)) return override;

  const output: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override)) {
    output[key] = mergeConfig(output[key], value);
  }
  return output;
}

async function readYamlIfExists(filePath: string): Promise<unknown> {
  try {
    const content = await readFile(filePath, 'utf8');
    return YAML.parse(content) ?? {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

export async function loadConfig(configPath = process.env.DANGBOT_CONFIG): Promise<AppConfig> {
  const defaultConfigPath = path.resolve(process.cwd(), 'config/default.yaml');
  const localConfigPath = configPath ? resolveFromCwd(configPath) : path.resolve(process.cwd(), 'config/local.yaml');

  const defaultConfig = await readYamlIfExists(defaultConfigPath);
  const localConfig = await readYamlIfExists(localConfigPath);
  const merged = expandEnv(mergeConfig(defaultConfig, localConfig));
  const parsed = configSchema.parse(merged) as AppConfig;

  parsed.bot.mentionAliases = Array.from(new Set([parsed.bot.name, ...parsed.bot.mentionAliases]));
  parsed.storage.sqlitePath = resolveFromCwd(parsed.storage.sqlitePath);
  parsed.storage.uploadsDir = resolveFromCwd(parsed.storage.uploadsDir);
  parsed.storage.outputsDir = resolveFromCwd(parsed.storage.outputsDir);
  parsed.logging.file = resolveFromCwd(parsed.logging.file);

  return parsed;
}
