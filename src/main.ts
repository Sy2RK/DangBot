import { loadConfig } from './config.js';
import { WechatyAdapter } from './adapters/wechaty/wechatyAdapter.js';
import { BotRequestRouter } from './core/router.js';
import { AutomationScheduler } from './domain/automations.js';
import { TaskQueue } from './domain/taskQueue.js';
import { ReflectionScheduler } from './domain/reflectionScheduler.js';
import { createLogger } from './logger.js';
import { FileService } from './services/files/fileService.js';
import { ArtifactBroker } from './services/artifacts/artifactBroker.js';
import { HermesBackendClient } from './services/hermes/hermesBackendClient.js';
import { HermesTaskExecutor } from './services/hermes/hermesTaskExecutor.js';
import { DashScopeMediaClient } from './services/llm/dashScopeClient.js';
import { DangBotMcpServer } from './services/mcp/dangbotMcpServer.js';
import { PortableCodeSandbox } from './services/sandbox/portableCodeSandbox.js';
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
  const invalidatedContexts = db.invalidateAllMcpContexts();
  if (invalidatedContexts > 0) {
    logger.info({ invalidatedContexts }, 'stale MCP capabilities invalidated at startup');
  }

  const fileService = new FileService(config);
  const systemPrompt = await loadSoulPrompt();
  const media = new DashScopeMediaClient(config.media, config.storage.outputsDir);
  const artifactBroker = new ArtifactBroker(config, db);
  const hermesClient = new HermesBackendClient(config.agent.hermes);
  const portableSandbox = new PortableCodeSandbox(config.agent.sandbox);
  const mcpServer = new DangBotMcpServer(
    config,
    db,
    media,
    fileService,
    artifactBroker,
    portableSandbox,
    logger
  );
  const hermesExecutor = new HermesTaskExecutor(
    config,
    db,
    hermesClient,
    artifactBroker,
    logger,
    systemPrompt,
    (taskId) => mcpServer.cancelTask(taskId)
  );
  const queue = new TaskQueue(db, logger, {
    maxConcurrentTasks: config.limits.maxConcurrentTasks,
    maxConcurrentLongTasks: config.limits.maxConcurrentLongTasks,
    taskTimeoutMs: config.limits.taskTimeoutMs
  });
  if (config.agent.hermes.maxConcurrentRuns > config.limits.maxConcurrentTasks) {
    throw new Error('Hermes 并发不能高于 DangBot 任务队列并发。');
  }
  if (
    config.agent.hermes.requestTimeoutMs <
    config.limits.videoGenerationTimeoutMs + 60_000
  ) {
    throw new Error('Hermes 总超时必须至少比视频生成超时多 60 秒。');
  }
  if (!hermesExecutor.configured()) throw new Error('独立 Hermes API 或会话密钥未安全配置。');
  if (!mcpServer.configured()) throw new Error('DangBot MCP 或 scoped Memory Bridge 未安全配置。');
  if (!portableSandbox.configured()) throw new Error('QuickJS 安全执行层未启用。');
  if (!media.configured()) throw new Error('DashScope 专用媒体凭据未配置。');
  if (config.media.tts.enabled && !media.speechConfigured()) {
    throw new Error('Qwen Audio TTS 已启用但专用凭据未配置。');
  }
  await mcpServer.start();
  await hermesExecutor.health(AbortSignal.timeout(5_000));
  const router = new BotRequestRouter(
    config,
    db,
    queue,
    fileService,
    artifactBroker,
    logger,
    hermesExecutor
  );
  const adapter = new WechatyAdapter(config, router, logger);
  const automationScheduler = new AutomationScheduler(
    config,
    db,
    router,
    {
      createRoomResponder: (roomId) => adapter.createRoomResponder(roomId)
    },
    logger
  );
  const reflectionScheduler = new ReflectionScheduler(config, db, queue, hermesExecutor, logger);
  const keepAlive = setInterval(() => {
    logger.debug('dangbot keepalive');
  }, 60_000);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    clearInterval(keepAlive);
    automationScheduler.stop();
    reflectionScheduler.stop();
    await adapter.stop();
    await mcpServer.stop();
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
      agentBackend: 'hermes-only',
      hermesConfigured: hermesExecutor.configured(),
      mcpConfigured: mcpServer.configured(),
      mediaConfigured: media.configured(),
      scopedMemoryProvider: 'dangbot_scoped',
      soulConfigured: systemPrompt.length > 0
    },
    'starting DangBot'
  );

  await adapter.start();
  automationScheduler.start();
  reflectionScheduler.start();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.name : 'DangBot startup failed');
  process.exit(1);
});
