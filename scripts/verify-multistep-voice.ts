import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { loadConfig } from '../src/config.js';
import { BotRequestRouter } from '../src/core/router.js';
import { TaskQueue } from '../src/domain/taskQueue.js';
import { FileService } from '../src/services/files/fileService.js';
import { OpenAICompatibleClient } from '../src/services/llm/openaiCompatibleClient.js';
import { BraveSearchClient } from '../src/services/search/braveSearchClient.js';
import { loadSoulPrompt } from '../src/soul.js';
import { AppDatabase } from '../src/storage/database.js';
import type { BotResponder, IncomingMessage } from '../src/types.js';

const verificationRoomId = 'integration-voice-agent';
const verificationUserId = 'integration-user';
let verificationOutputDir: string | undefined;

class VerificationResponder implements BotResponder {
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

async function main(): Promise<void> {
  const loaded = await loadConfig();
  verificationOutputDir = await mkdtemp(path.join(os.tmpdir(), 'dangbot-voice-agent-'));
  const config = {
    ...loaded,
    storage: {
      ...loaded.storage,
      uploadsDir: verificationOutputDir,
      outputsDir: verificationOutputDir
    },
    auth: {
      ...loaded.auth,
      systemAdmins: [],
      rooms: [
        {
          id: verificationRoomId,
          topic: '多步语音验证',
          enabled: true,
          admins: []
        }
      ]
    }
  };
  const logger = pino({ level: 'info' });
  const db = AppDatabase.memory();
  db.seedConfig(config);
  const queue = new TaskQueue(db, logger, {
    maxConcurrentTasks: 1,
    maxConcurrentLongTasks: 1,
    taskTimeoutMs: config.limits.agentTaskTimeoutMs
  });
  const systemPrompt = await loadSoulPrompt();
  const llm = new OpenAICompatibleClient(config.llm, config.storage.outputsDir, systemPrompt);
  const router = new BotRequestRouter(
    config,
    db,
    queue,
    llm,
    new FileService(config),
    logger,
    systemPrompt,
    undefined,
    new BraveSearchClient(config.search)
  );
  const responder = new VerificationResponder();
  const message: IncomingMessage = {
    id: `verify-${Date.now()}`,
    roomId: verificationRoomId,
    roomTopic: '多步语音验证',
    senderId: verificationUserId,
    senderName: 'Integration User',
    text: '@DangBot 朗读一下滕王阁序',
    mentioned: true,
    mentionText: '朗读一下滕王阁序',
    attachments: [],
    timestamp: new Date()
  };

  await router.handleMessage(message, responder);
  const task = await waitForTask(db);
  const toolCalls = db.listTaskToolCalls(task.id);
  const voiceCall = toolCalls.find((call) => call.toolName === 'voice.generate');
  const preparationCall = toolCalls.find((call) => call.toolName === 'text.prepare');
  const preparationInput = preparationCall
    ? (JSON.parse(preparationCall.inputJson) as {
        source?: string;
        startMarker?: string;
        endMarker?: string;
      })
    : undefined;
  const voiceInput = voiceCall
    ? (JSON.parse(voiceCall.inputJson) as { text?: string }).text?.trim() ?? ''
    : '';
  const outputPath = responder.files[0];
  const outputBytes = outputPath
    ? await stat(outputPath)
        .then((value) => value.size)
        .catch(() => 0)
    : 0;
  const report = {
    taskStatus: task.status,
    requestType: task.requestType,
    tools: toolCalls.map((call) => call.toolName),
    notice: responder.texts[0],
    outputBytes,
    speechChars: voiceInput.length,
    speechStart: voiceInput.slice(0, 24),
    speechEnd: voiceInput.slice(-24),
    preparationStartMarker: preparationInput?.startMarker,
    preparationEndMarker: preparationInput?.endMarker,
    preparationSourceEnd: preparationInput?.source?.slice(-80),
    containsCommandFiller: /朗读|帮我|一下/.test(voiceInput),
    containsTitlePlaceholder: /《滕王阁序》/.test(voiceInput)
  };
  const compactSpeech = voiceInput.replace(/[\s，。！？、；：“”‘’（）《》,.!?;:'"()[\]{}\-—]/gu, '');
  console.log(JSON.stringify(report, null, 2));

  if (
    task.status !== 'completed' ||
    toolCalls[0]?.toolName !== 'web.search' ||
    toolCalls[1]?.toolName !== 'text.prepare' ||
    toolCalls[2]?.toolName !== 'voice.generate' ||
    responder.texts[0] !== '好哒，我这就念给你听，喵～' ||
    outputBytes <= 0 ||
    voiceInput.length < 500 ||
    report.containsCommandFiller ||
    report.containsTitlePlaceholder ||
    !compactSpeech.endsWith('请洒潘江各倾陆海云尔') ||
    /滕王高阁临江渚|槛外长江空自流/.test(voiceInput)
  ) {
    throw new Error(`多步语音验证失败：${JSON.stringify(report)}`);
  }
}

async function waitForTask(db: AppDatabase) {
  const deadline = Date.now() + 330_000;
  while (Date.now() < deadline) {
    const task = db.listRoomTasks(verificationRoomId, 1)[0];
    if (task && ['completed', 'failed', 'cancelled'].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('等待多步语音任务超时。');
}

void main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (verificationOutputDir) {
      await rm(verificationOutputDir, { recursive: true, force: true });
    }
  });
