import { loadConfig } from './config.js';
import { WechatyAdapter } from './adapters/wechaty/wechatyAdapter.js';
import { BotRequestRouter } from './core/router.js';
import { MemoryConsolidationService } from './domain/memoryConsolidation.js';
import { TaskQueue } from './domain/taskQueue.js';
import { createLogger } from './logger.js';
import { FileService } from './services/files/fileService.js';
import { OpenAICompatibleClient } from './services/llm/openaiCompatibleClient.js';
import { AppDatabase } from './storage/database.js';
import { loadSoulPrompt } from './soul.js';
import { ensureDir } from './utils/fs.js';

async function main(): Promise<void> {
  const config = await loadConfig();
  const logger = await createLogger(config);

  await ensureDir(config.storage.uploadsDir);
  await ensureDir(config.storage.outputsDir);

  const db = await AppDatabase.open(config.storage.sqlitePath);
  db.seedConfig(config);
  const expiredCount = db.cleanupExpiredAttachments();
  if (expiredCount > 0) {
    logger.info({ expiredCount }, 'expired attachment records cleaned');
  }

  const fileService = new FileService(config);
  const systemPrompt = await loadSoulPrompt();
  const llm = new OpenAICompatibleClient(config.llm, config.storage.outputsDir, systemPrompt);
  const queue = new TaskQueue(db, logger, {
    maxConcurrentTasks: config.limits.maxConcurrentTasks,
    maxConcurrentLongTasks: config.limits.maxConcurrentLongTasks,
    taskTimeoutMs: config.limits.taskTimeoutMs
  });
  const memoryConsolidation = new MemoryConsolidationService(config, db, llm, logger);
  memoryConsolidation.start();
  const router = new BotRequestRouter(config, db, queue, llm, fileService, logger, systemPrompt, memoryConsolidation);
  const adapter = new WechatyAdapter(config, router, logger);
  const keepAlive = setInterval(() => {
    logger.debug('dangbot keepalive');
  }, 60_000);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    clearInterval(keepAlive);
    memoryConsolidation.stop();
    await adapter.stop();
    db.close();
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  logger.info(
    {
      botName: config.bot.name,
      puppet: process.env.WECHATY_PUPPET ?? config.wechat.puppet,
      sqlitePath: config.storage.sqlitePath,
      llmConfigured: llm.configured(),
      soulConfigured: systemPrompt.length > 0
    },
    'starting DangBot'
  );

  await adapter.start();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
