import { loadConfig } from './config.js';
import { WechatyAdapter } from './adapters/wechaty/wechatyAdapter.js';
import { BotRequestRouter } from './core/router.js';
import { AutomationScheduler } from './domain/automations.js';
import { MemoryConsolidationService } from './domain/memoryConsolidation.js';
import { TaskQueue } from './domain/taskQueue.js';
import { createLogger } from './logger.js';
import { FileService } from './services/files/fileService.js';
import { ArtifactBroker } from './services/artifacts/artifactBroker.js';
import { HermesBackendClient } from './services/hermes/hermesBackendClient.js';
import { HermesTaskExecutor } from './services/hermes/hermesTaskExecutor.js';
import { OpenAICompatibleClient } from './services/llm/openaiCompatibleClient.js';
import { DangBotMcpServer } from './services/mcp/dangbotMcpServer.js';
import { PortableCodeSandbox } from './services/sandbox/portableCodeSandbox.js';
import { BraveSearchClient } from './services/search/braveSearchClient.js';
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
  const webSearch = new BraveSearchClient(config.search);
  const artifactBroker = new ArtifactBroker(config, db);
  const hermesClient = new HermesBackendClient(config.agent.hermes);
  const portableSandbox = new PortableCodeSandbox(config.agent.sandbox);
  const mcpServer = new DangBotMcpServer(
    config,
    db,
    llm,
    fileService,
    artifactBroker,
    portableSandbox,
    logger,
    systemPrompt,
    webSearch
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
  const memoryConsolidation = new MemoryConsolidationService(config, db, llm, logger);
  if (config.agent.backend === 'legacy') memoryConsolidation.start();
  if (mcpServer.configured()) await mcpServer.start();
  if (config.agent.backend === 'hermes') {
    if (config.agent.hermes.maxConcurrentRuns > config.limits.maxConcurrentTasks) {
      throw new Error('Hermes 并发不能高于 DangBot 任务队列并发。');
    }
    if (!hermesExecutor.configured()) {
      throw new Error('agent.backend=hermes，但独立 Hermes API 或会话密钥未配置。');
    }
    if (!mcpServer.configured()) {
      throw new Error('agent.backend=hermes，但 DangBot MCP 未安全配置。');
    }
  }
  const router = new BotRequestRouter(
    config,
    db,
    queue,
    llm,
    fileService,
    logger,
    systemPrompt,
    memoryConsolidation,
    webSearch,
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
  const keepAlive = setInterval(() => {
    logger.debug('dangbot keepalive');
  }, 60_000);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    clearInterval(keepAlive);
    automationScheduler.stop();
    memoryConsolidation.stop();
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
      agentBackend: config.agent.backend,
      hermesConfigured: hermesExecutor.configured(),
      mcpConfigured: mcpServer.configured(),
      llmConfigured: llm.configured(),
      webSearchConfigured:
        config.search.enabled &&
        (config.search.provider === 'openrouter'
          ? llm.configured()
          : config.search.provider === 'hermes'
            ? config.agent.backend === 'hermes' && hermesExecutor.configured()
            : webSearch.configured()),
      soulConfigured: systemPrompt.length > 0
    },
    'starting DangBot'
  );

  await adapter.start();
  automationScheduler.start();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
