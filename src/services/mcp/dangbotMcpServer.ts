import { createHash, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse
} from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import type { Logger } from 'pino';
import type {
  AppConfig,
  AutomationRecord,
  AttachmentKind,
  AttachmentRecord,
  McpContextRecord,
  HermesSessionRecord,
  MemoryProposalScope,
  TaskRecord,
  ToolRiskLevel
} from '../../types.js';
import type { AppDatabase } from '../../storage/database.js';
import type { FileService } from '../files/fileService.js';
import type { ArtifactBroker } from '../artifacts/artifactBroker.js';
import type { PortableCodeSandbox } from '../sandbox/portableCodeSandbox.js';
import type {
  DashScopeMediaClient,
  DashScopeMediaInput,
  DashScopeVideoMode
} from '../llm/dashScopeClient.js';
import { SlidingWindowRateLimiter } from '../../domain/rateLimiter.js';
import {
  serializeScheduleSpec,
  validateScheduleSpec
} from '../../domain/automations.js';
import { nowIso } from '../../utils/time.js';
import {
  redactSensitiveText,
  redactToolAuditInput,
  safeErrorSummary
} from '../../utils/redaction.js';

const contextIdSchema = z.string().min(32).max(128);
const attachmentIdSchema = z.string().regex(/^att_[a-zA-Z0-9-]{8,80}$/u);
const automationIdSchema = z.string().regex(/^auto_[a-f0-9-]{8,36}$/iu);
const proposalScopeSchema = z.enum(['user', 'room', 'agent']);

const requiredDangBotTools = [
  'dangbot_attachment_list',
  'dangbot_file_extract',
  'dangbot_image_analyze',
  'dangbot_video_analyze',
  'dangbot_image_generate',
  'dangbot_video_generate',
  'dangbot_tts_generate',
  'dangbot_document_render',
  'dangbot_room_context',
  'dangbot_javascript_execute',
  'dangbot_automation_create',
  'dangbot_automation_list',
  'dangbot_automation_update',
  'dangbot_automation_delete',
  'dangbot_memory_recall',
  'dangbot_memory_propose',
  'dangbot_memory_feedback'
] as const;

interface ToolPayload {
  status: 'ok';
  summary: string;
  artifactIds: string[];
  data: unknown;
}

interface ToolWorkResult {
  summary: string;
  data?: unknown;
  filePath?: string;
  imagePath?: string;
}

interface MemoryToolResult {
  status: 'ok';
  summary: string;
  data?: unknown;
}

export class DangBotMcpServer {
  private httpServer?: HttpServer;
  private readonly activeControllers = new Map<string, Set<AbortController>>();
  private readonly limiter = new SlidingWindowRateLimiter();
  private videoLease = false;

  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
    private readonly media: DashScopeMediaClient,
    private readonly fileService: FileService,
    private readonly artifactBroker: ArtifactBroker,
    private readonly sandbox: PortableCodeSandbox,
    private readonly logger: Logger
  ) {}

  configured(): boolean {
    return Boolean(
      this.config.agent.mcp.enabled &&
        isLoopbackHost(this.config.agent.mcp.host) &&
        this.config.agent.mcp.apiKey.trim().length >= 32 &&
        isLoopbackUrl(this.config.agent.memoryBridge.baseURL) &&
        this.config.agent.memoryBridge.apiKey.trim().length >= 32
    );
  }

  async start(): Promise<void> {
    if (!this.config.agent.mcp.enabled || this.httpServer) return;
    if (!this.configured()) {
      throw new Error('DangBot MCP 与 Memory Bridge 必须使用回环地址和独立的 32 字符以上密钥。');
    }
    this.db.cleanupExpiredMcpContexts();
    const server = createServer((request, response) => {
      void this.handleHttpRequest(request, response).catch((error) => {
        if (error instanceof SafeToolError) {
          if (!response.headersSent) response.writeHead(403, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: error.code }));
          return;
        }
        this.logger.error({ error }, 'DangBot safe service request failed');
        if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'internal_error' }));
      });
    });
    this.httpServer = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.config.agent.mcp.port, this.config.agent.mcp.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.logger.info(
      { host: this.config.agent.mcp.host, port: this.config.agent.mcp.port },
      'DangBot MCP and scoped memory bridge started'
    );
  }

  async stop(): Promise<void> {
    for (const taskId of this.activeControllers.keys()) this.cancelTask(taskId);
    const server = this.httpServer;
    this.httpServer = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }

  boundPort(): number | undefined {
    const address = this.httpServer?.address();
    return address && typeof address === 'object' ? address.port : undefined;
  }

  async assertReady(): Promise<string[]> {
    const port = this.boundPort();
    if (!port) throw new Error('DangBot MCP 尚未监听，拒绝接入微信流量。');
    const client = new Client({ name: 'dangbot-startup-probe', version: '2.0.0' });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://${this.config.agent.mcp.host}:${port}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${this.config.agent.mcp.apiKey}` } } }
    );
    try {
      await client.connect(transport);
      const response = await client.listTools();
      const actual = response.tools.map((tool) => tool.name).sort();
      const expected = [...requiredDangBotTools].sort();
      if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
        throw new Error(
          `DangBot MCP 工具面不匹配：expected=${expected.join(',')} actual=${actual.join(',')}`
        );
      }
      return actual;
    } finally {
      await transport.close().catch(() => undefined);
    }
  }

  cancelTask(taskId: string): void {
    for (const controller of this.activeControllers.get(taskId) ?? []) {
      controller.abort(new Error('DangBot task cancelled'));
    }
    this.activeControllers.delete(taskId);
    this.db.revokeMcpContext(taskId);
  }

  private async handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/health' && request.method === 'GET') {
      if (!this.authorized(request, this.config.agent.mcp.apiKey)) return unauthorized(response);
      return sendJson(response, 200, {
        status: 'ok',
        sandbox: this.sandbox.configured(),
        memoryBridge: true,
        hostFileAccess: false,
        hostShell: false
      });
    }

    if (url.pathname.startsWith('/internal/memory/')) {
      if (!this.authorized(request, this.config.agent.memoryBridge.apiKey)) return unauthorized(response);
      if (request.method !== 'POST') return methodNotAllowed(response);
      return this.handleMemoryBridge(url.pathname, request, response);
    }

    if (url.pathname !== '/mcp') return sendJson(response, 404, { error: 'not_found' });
    if (!this.authorized(request, this.config.agent.mcp.apiKey)) return unauthorized(response);
    if (request.method !== 'POST') return methodNotAllowed(response);

    const mcp = this.createProtocolServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const closeProtocol = () => {
      void transport.close().catch(() => undefined);
      void mcp.close().catch(() => undefined);
    };
    response.once('close', closeProtocol);
    try {
      await mcp.connect(transport);
      await transport.handleRequest(request, response);
    } catch (error) {
      response.off('close', closeProtocol);
      closeProtocol();
      throw error;
    }
  }

  private createProtocolServer(): McpServer {
    const server = new McpServer({ name: 'dangbot-safe-tools', version: '2.0.0' });

    server.registerTool(
      'dangbot_attachment_list',
      {
        description: '列出当前任务获准使用的附件逻辑 ID 与安全元数据。',
        inputSchema: { contextId: contextIdSchema }
      },
      async ({ contextId }) => this.mcpResult(() => this.attachmentList(contextId))
    );
    server.registerTool(
      'dangbot_file_extract',
      {
        description: '按逻辑附件 ID 确定性分页抽取 TXT、MD、CSV、DOCX、PDF 或 XLSX 文本。',
        inputSchema: {
          contextId: contextIdSchema,
          attachmentId: attachmentIdSchema,
          cursor: z.number().int().min(0).default(0),
          maxChars: z.number().int().min(500).max(12_000).default(8_000)
        }
      },
      async ({ contextId, attachmentId, cursor, maxChars }) =>
        this.mcpResult(() => this.fileExtract(contextId, attachmentId, cursor, maxChars))
    );
    server.registerTool(
      'dangbot_image_analyze',
      {
        description: '用 qwen3.7-flash 分析一张获准图片；综合结论由 Hermes 完成。',
        inputSchema: {
          contextId: contextIdSchema,
          attachmentId: attachmentIdSchema,
          prompt: z.string().min(1).max(4_000)
        }
      },
      async ({ contextId, attachmentId, prompt }) =>
        this.mcpResult(() => this.imageAnalyze(contextId, attachmentId, prompt))
    );
    server.registerTool(
      'dangbot_video_analyze',
      {
        description: '用 qwen3.7-flash 分析一个获准视频；综合结论由 Hermes 完成。',
        inputSchema: {
          contextId: contextIdSchema,
          attachmentId: attachmentIdSchema,
          prompt: z.string().min(1).max(4_000)
        }
      },
      async ({ contextId, attachmentId, prompt }) =>
        this.mcpResult(() => this.videoAnalyze(contextId, attachmentId, prompt))
    );
    server.registerTool(
      'dangbot_image_generate',
      {
        description: '调用 qwen-image-3.0-pro 生成图片，可显式引用最多三张获准图片。',
        inputSchema: {
          contextId: contextIdSchema,
          prompt: z.string().min(1).max(4_000),
          referenceImageIds: z.array(attachmentIdSchema).max(3).default([])
        }
      },
      async ({ contextId, prompt, referenceImageIds }) =>
        this.mcpResult(() => this.imageGenerate(contextId, prompt, referenceImageIds))
    );
    server.registerTool(
      'dangbot_video_generate',
      {
        description: '按输入类型严格路由 HappyHorse 文生视频、首帧、多图参考或视频编辑模型。',
        inputSchema: {
          contextId: contextIdSchema,
          prompt: z.string().min(1).max(4_000),
          mode: z.enum(['text-to-video', 'image-to-video', 'reference-to-video', 'video-edit']),
          frameImageId: attachmentIdSchema.optional(),
          referenceImageIds: z.array(attachmentIdSchema).max(9).default([]),
          sourceVideoId: attachmentIdSchema.optional()
        }
      },
      async ({ contextId, prompt, mode, frameImageId, referenceImageIds, sourceVideoId }) =>
        this.mcpResult(() => this.videoGenerate(contextId, {
          prompt, mode, frameImageId, referenceImageIds, sourceVideoId
        }))
    );
    server.registerTool(
      'dangbot_tts_generate',
      {
        description: '把 Hermes 已准备好的最终正文交给 Qwen Audio TTS。',
        inputSchema: { contextId: contextIdSchema, text: z.string().min(1).max(4_096) }
      },
      async ({ contextId, text }) => this.mcpResult(() => this.ttsGenerate(contextId, text))
    );
    server.registerTool(
      'dangbot_document_render',
      {
        description: '确定性渲染 Hermes 已组织好的正文为 DOCX、TXT 或 Markdown，不调用第二个文字模型。',
        inputSchema: {
          contextId: contextIdSchema,
          title: z.string().min(1).max(120),
          body: z.string().min(1).max(120_000),
          format: z.enum(['docx', 'txt', 'md']),
          sourceAttachmentIds: z.array(attachmentIdSchema).max(5).default([])
        }
      },
      async ({ contextId, title, body, format, sourceAttachmentIds }) =>
        this.mcpResult(() => this.documentRender(contextId, title, body, format, sourceAttachmentIds))
    );
    server.registerTool(
      'dangbot_room_context',
      {
        description: '读取当前群有上限且有有效期的公开消息窗口，不能跨群。',
        inputSchema: { contextId: contextIdSchema, limit: z.number().int().min(1).max(40).default(20) }
      },
      async ({ contextId, limit }) => this.mcpResult(() => this.roomContext(contextId, limit))
    );
    server.registerTool(
      'dangbot_javascript_execute',
      {
        description: '在 QuickJS-WASM 中运行纯 JavaScript；没有网络、Shell、模块或宿主文件系统。',
        inputSchema: { contextId: contextIdSchema, code: z.string().min(1).max(64 * 1024) }
      },
      async ({ contextId, code }) => this.mcpResult(() => this.executeJavaScript(contextId, code))
    );
    server.registerTool(
      'dangbot_memory_recall',
      {
        description: '召回当前群当前用户、当前群共享记忆和已批准 Agent 经验，不跨作用域。',
        inputSchema: { contextId: contextIdSchema }
      },
      async ({ contextId }) => this.mcpResult(() => this.memoryRecall(contextId))
    );
    server.registerTool(
      'dangbot_memory_propose',
      {
        description: '提出个人、本群或 Agent 经验记忆；自动写入与审批规则由服务端强制执行。',
        inputSchema: {
          contextId: contextIdSchema,
          scope: proposalScopeSchema,
          content: z.string().min(1).max(2_000),
          evidence: z.string().min(1).max(4_000),
          confidence: z.number().min(0).max(1)
        }
      },
      async ({ contextId, scope, content, evidence, confidence }) =>
        this.mcpResult(() =>
          this.memoryTool(contextId, 'dangbot_memory_propose', {
            scope,
            content,
            evidence,
            confidence
          })
        )
    );
    server.registerTool(
      'dangbot_memory_feedback',
      {
        description: '记录当前用户纠正、稳定偏好、明确期待或工具恢复信号，供隔离批量反思。',
        inputSchema: {
          contextId: contextIdSchema,
          signal: z.string().min(1).max(80),
          evidence: z.string().min(1).max(4_000)
        }
      },
      async ({ contextId, signal, evidence }) =>
        this.mcpResult(() =>
          this.memoryTool(contextId, 'dangbot_memory_feedback', { signal, evidence })
        )
    );
    this.registerAutomationTools(server);
    return server;
  }

  private registerAutomationTools(server: McpServer): void {
    const scheduleType = z.enum(['once', 'daily', 'weekly', 'interval']);
    server.registerTool(
      'dangbot_automation_create',
      {
        description: '创建严格结构的自动任务；自然语言日程必须先由 Hermes 理解。仅群管理员可用。',
        inputSchema: {
          contextId: contextIdSchema,
          name: z.string().min(1).max(80),
          kind: z.enum(['reminder', 'scheduled_prompt']),
          scheduleType,
          schedule: z.record(z.string(), z.unknown()),
          timezone: z.string().min(1).max(80).default(this.config.automations.timezone),
          prompt: z.string().min(1).max(8_000)
        }
      },
      async ({ contextId, name, kind, scheduleType: type, schedule, timezone, prompt }) =>
        this.mcpResult(() => this.automationCreate(contextId, { name, kind, scheduleType: type, schedule, timezone, prompt }))
    );
    server.registerTool(
      'dangbot_automation_list',
      {
        description: '列出当前群自动任务，不跨群。',
        inputSchema: { contextId: contextIdSchema }
      },
      async ({ contextId }) => this.mcpResult(() => this.automationList(contextId))
    );
    server.registerTool(
      'dangbot_automation_update',
      {
        description: '更新当前群自动任务状态或严格日程。仅群管理员可用。',
        inputSchema: {
          contextId: contextIdSchema,
          automationId: automationIdSchema,
          status: z.enum(['active', 'paused']).optional(),
          scheduleType: scheduleType.optional(),
          schedule: z.record(z.string(), z.unknown()).optional(),
          timezone: z.string().min(1).max(80).optional(),
          prompt: z.string().min(1).max(8_000).optional()
        }
      },
      async (input) => this.mcpResult(() => this.automationUpdate(input))
    );
    server.registerTool(
      'dangbot_automation_delete',
      {
        description: '删除当前群自动任务。仅群管理员可用。',
        inputSchema: { contextId: contextIdSchema, automationId: automationIdSchema }
      },
      async ({ contextId, automationId }) => this.mcpResult(() => this.automationDelete(contextId, automationId))
    );
  }

  private async attachmentList(contextId: string): Promise<ToolPayload> {
    const { context, task } = this.resolveContext(contextId);
    const attachments = this.authorizedAttachments(context, task);
    return ok(`当前任务有 ${attachments.length} 个授权附件。`, attachments.map(safeAttachment));
  }

  private async fileExtract(contextId: string, attachmentId: string, cursor: number, maxChars: number): Promise<ToolPayload> {
    return this.runTool(contextId, 'dangbot_file_extract', 'low', { attachmentId, cursor, maxChars }, async ({ context, task }) => {
      const attachment = await this.verifyAttachment(context, task, attachmentId, 'file');
      const text = await this.fileService.extractText(attachment);
      if (cursor > text.length) throw new SafeToolError('invalid_cursor', 'cursor 超过附件文本长度。');
      const safeMaxChars = Math.max(
        500,
        Math.min(maxChars, this.config.limits.maxMcpOutputChars - 1_000)
      );
      const chunk = text.slice(cursor, cursor + safeMaxChars);
      const nextCursor = cursor + chunk.length;
      return {
        summary: `已抽取 ${chunk.length} 个字符。`,
        data: { attachmentId, cursor, nextCursor, done: nextCursor >= text.length, text: chunk }
      };
    });
  }

  private async imageAnalyze(contextId: string, attachmentId: string, prompt: string): Promise<ToolPayload> {
    return this.runTool(contextId, 'dangbot_image_analyze', 'medium', { attachmentId, prompt }, async ({ context, task, signal }) => {
      this.assertRate('image', context, this.config.limits.imageTasksPerMinute);
      const attachment = await this.verifyAttachment(context, task, attachmentId, 'image');
      const text = await this.media.analyzeImage(prompt, toMedia(attachment), signal);
      return { summary: text, data: { attachmentId, model: this.config.media.multimodalModel } };
    });
  }

  private async videoAnalyze(contextId: string, attachmentId: string, prompt: string): Promise<ToolPayload> {
    return this.runTool(contextId, 'dangbot_video_analyze', 'medium', { attachmentId, prompt }, async ({ context, task, signal }) => {
      this.assertRate('video', context, this.config.limits.videoTasksPerMinute);
      const attachment = await this.verifyAttachment(context, task, attachmentId, 'video');
      const text = await this.media.analyzeVideo(prompt, toMedia(attachment), signal);
      return { summary: text, data: { attachmentId, model: this.config.media.multimodalModel } };
    });
  }

  private async imageGenerate(contextId: string, prompt: string, referenceIds: string[]): Promise<ToolPayload> {
    return this.runTool(contextId, 'dangbot_image_generate', 'medium', { prompt, referenceIds }, async ({ context, task, signal }) => {
      this.assertRate('image_generation', context, this.config.limits.imageGenerationTasksPerMinute);
      this.assertGlobalRate(
        'image_generation',
        this.config.limits.imageGenerationTasksPerMinute
      );
      const references = await Promise.all(
        referenceIds.map(async (id) => toMedia(await this.verifyAttachment(context, task, id, 'image')))
      );
      const imagePath = await this.media.generateImage(prompt, { referenceImages: references }, signal);
      return { summary: '图片已生成并交给产物代理校验。', imagePath, data: { model: this.config.media.imageModel, referenceCount: references.length } };
    });
  }

  private async videoGenerate(
    contextId: string,
    input: {
      prompt: string;
      mode: Exclude<DashScopeVideoMode, 'auto'>;
      frameImageId?: string;
      referenceImageIds: string[];
      sourceVideoId?: string;
    }
  ): Promise<ToolPayload> {
    return this.runTool(contextId, 'dangbot_video_generate', 'medium', input, async ({ context, task, signal }) => {
      this.assertRate('video', context, this.config.limits.videoTasksPerMinute);
      if (this.videoLease) throw new SafeToolError('resource_busy', '视频生成并发已满，请稍后重试或重新规划。');
      this.videoLease = true;
      try {
        const frame = input.frameImageId
          ? toMedia(await this.verifyAttachment(context, task, input.frameImageId, 'image'))
          : undefined;
        const references = await Promise.all(
          input.referenceImageIds.map(async (id) =>
            toMedia(await this.verifyAttachment(context, task, id, 'image'))
          )
        );
        const source = input.sourceVideoId
          ? toMedia(await this.verifyAttachment(context, task, input.sourceVideoId, 'video'))
          : undefined;
        validateVideoRoute(input.mode, frame, references, source);
        const filePath = await this.media.generateVideo(input.prompt, {
          mode: input.mode,
          frameImage: frame,
          referenceImages: references,
          sourceVideo: source,
          timeoutMs: this.config.limits.videoGenerationTimeoutMs,
          pollIntervalMs: this.config.limits.videoGenerationPollIntervalMs
        }, signal);
        return {
          summary: '视频已生成并交给产物代理校验。',
          filePath,
          data: { route: input.mode, model: modelForVideoRoute(this.config, input.mode) }
        };
      } finally {
        this.videoLease = false;
      }
    }, this.config.limits.videoGenerationTimeoutMs);
  }

  private async ttsGenerate(contextId: string, text: string): Promise<ToolPayload> {
    return this.runTool(contextId, 'dangbot_tts_generate', 'medium', { textLength: text.length }, async ({ context, signal }) => {
      this.assertRate('tts', context, this.config.limits.voiceTasksPerMinute);
      const voice = await this.media.generateVoice(text, signal);
      return { summary: '语音已合成并交给产物代理校验。', filePath: voice.filePath, data: { model: this.config.media.tts.model } };
    });
  }

  private async documentRender(
    contextId: string,
    title: string,
    body: string,
    format: 'docx' | 'txt' | 'md',
    sourceIds: string[]
  ): Promise<ToolPayload> {
    return this.runTool(contextId, 'dangbot_document_render', 'low', { title, bodyLength: body.length, format, sourceIds }, async ({ context, task }) => {
      for (const id of sourceIds) await this.verifyAttachment(context, task, id, 'file');
      const filePath = await this.fileService.writeDocumentResult(title, body, format);
      return { summary: `${format.toUpperCase()} 文档已确定性渲染。`, filePath, data: { format, sourceAttachmentIds: sourceIds } };
    });
  }

  private async roomContext(contextId: string, limit: number): Promise<ToolPayload> {
    const { context } = this.resolveContext(contextId);
    const messages = this.db.listRecentRoomMessages(context.roomId, limit);
    return ok(`读取到当前群最近 ${messages.length} 条公开消息。`, messages.map((message) => ({
      sender: this.db.getUserDisplayName(message.userId) ?? '群成员',
      text: message.text.slice(0, 4_000),
      mentionedBot: message.mentioned,
      createdAt: message.createdAt
    })));
  }

  private async executeJavaScript(contextId: string, code: string): Promise<ToolPayload> {
    return this.runTool(contextId, 'dangbot_javascript_execute', 'low', { codeBytes: Buffer.byteLength(code) }, async ({ signal }) => {
      const result = await this.sandbox.executeJavaScript(code, signal);
      return { summary: result.stdout || 'JavaScript 计算已完成。', data: result };
    }, this.config.agent.sandbox.maxExecutionMs);
  }

  private async automationCreate(
    contextId: string,
    input: {
      name: string;
      kind: 'reminder' | 'scheduled_prompt';
      scheduleType: 'once' | 'daily' | 'weekly' | 'interval';
      schedule: Record<string, unknown>;
      timezone: string;
      prompt: string;
    }
  ): Promise<ToolPayload> {
    const { context } = this.resolveContext(contextId);
    this.assertAdmin(context);
    const validated = validateScheduleSpec(input.scheduleType, input.schedule, new Date(), input.timezone);
    const automation = this.db.createAutomation({
      roomId: context.roomId,
      creatorId: context.userId,
      name: input.name,
      kind: input.kind,
      scheduleType: input.scheduleType,
      scheduleSpecJson: serializeScheduleSpec(validated.spec),
      timezone: input.timezone,
      prompt: input.prompt,
      nextRunAt: validated.nextRunAt
    });
    return ok(`自动任务 ${automation.id} 已创建。`, safeAutomation(automation));
  }

  private async automationList(contextId: string): Promise<ToolPayload> {
    const { context } = this.resolveContext(contextId);
    const automations = this.db.listRoomAutomations(context.roomId);
    return ok(`当前群有 ${automations.length} 个自动任务。`, automations.map(safeAutomation));
  }

  private async automationUpdate(input: {
    contextId: string;
    automationId: string;
    status?: 'active' | 'paused';
    scheduleType?: 'once' | 'daily' | 'weekly' | 'interval';
    schedule?: Record<string, unknown>;
    timezone?: string;
    prompt?: string;
  }): Promise<ToolPayload> {
    const { context } = this.resolveContext(input.contextId);
    this.assertAdmin(context);
    const current = this.resolveAutomation(context, input.automationId);
    if ((input.scheduleType && !input.schedule) || (!input.scheduleType && input.schedule)) {
      throw new SafeToolError('invalid_schedule', 'scheduleType 与 schedule 必须同时提供。');
    }
    const timezone = input.timezone ?? current.timezone;
    const schedule = input.scheduleType && input.schedule
      ? validateScheduleSpec(input.scheduleType, input.schedule, new Date(), timezone)
      : undefined;
    const updated = this.db.updateAutomation(current.id, {
      status: input.status,
      prompt: input.prompt,
      scheduleType: input.scheduleType,
      scheduleSpecJson: schedule ? serializeScheduleSpec(schedule.spec) : undefined,
      timezone: input.timezone,
      nextRunAt: schedule?.nextRunAt
    });
    return ok(`自动任务 ${current.id} 已更新。`, safeAutomation(updated!));
  }

  private async automationDelete(contextId: string, automationId: string): Promise<ToolPayload> {
    const { context } = this.resolveContext(contextId);
    this.assertAdmin(context);
    const automation = this.resolveAutomation(context, automationId);
    this.db.deleteAutomation(automation.id);
    return ok(`自动任务 ${automation.id} 已删除。`, { automationId: automation.id });
  }

  private async runTool(
    contextId: string,
    toolName: string,
    riskLevel: ToolRiskLevel,
    input: unknown,
    work: (resolved: { context: McpContextRecord; task: TaskRecord; signal: AbortSignal }) => Promise<ToolWorkResult>,
    timeoutMs = this.config.limits.agentTaskTimeoutMs
  ): Promise<ToolPayload> {
    const resolved = this.resolveContext(contextId);
    const toolCall = this.db.createToolCall({
      taskId: resolved.task.id,
      roomId: resolved.context.roomId,
      userId: resolved.context.userId,
      toolName,
      riskLevel,
      inputJson: JSON.stringify(redactToolAuditInput(input))
    });
    this.db.updateToolCall(toolCall.id, { status: 'running', startedAt: nowIso() });
    const operation = this.beginTaskOperation(resolved.task.id);
    const timeout = setTimeout(() => operation.controller.abort(new Error('tool timeout')), timeoutMs);
    try {
      const result = await work({ ...resolved, signal: operation.controller.signal });
      const run = this.db.getHermesRunByTask(resolved.task.id);
      const artifacts = await this.artifactBroker.registerToolResult(resolved.task.id, run?.runId, result);
      const summary = redactHostPaths(result.summary).slice(0, this.config.limits.maxMcpOutputChars);
      this.db.updateToolCall(toolCall.id, {
        status: 'completed',
        resultKind: artifacts[0]?.kind === 'image' ? 'image' : artifacts.length > 0 ? 'file' : 'text',
        resultPreview: artifacts.length > 0 ? '[artifact]' : summary,
        completedAt: nowIso()
      });
      if (
        this.db
          .listTaskToolCalls(resolved.task.id)
          .some((call) => call.id !== toolCall.id && call.toolName === toolName && call.status === 'failed')
      ) {
        this.db.addReflectionCandidate({
          roomId: resolved.context.roomId,
          userId: resolved.context.userId,
          taskId: resolved.task.id,
          signal: 'tool_recovery',
          evidence: `${toolName} 在失败后成功恢复。`
        });
      }
      return { status: 'ok', summary, artifactIds: artifacts.map((artifact) => artifact.id), data: sanitizeData(result.data) };
    } catch (error) {
      this.db.updateToolCall(toolCall.id, {
        status: operation.controller.signal.aborted ? 'cancelled' : 'failed',
        error: safeErrorMessage(error),
        completedAt: nowIso()
      });
      this.db.addReflectionCandidate({
        roomId: resolved.context.roomId,
        userId: resolved.context.userId,
        taskId: resolved.task.id,
        signal: 'tool_failure',
        evidence: `${toolName}: ${safeErrorMessage(error).slice(0, 300)}`
      });
      throw error;
    } finally {
      clearTimeout(timeout);
      operation.done();
    }
  }

  private authorizedAttachments(context: McpContextRecord, task: TaskRecord): AttachmentRecord[] {
    return this.db.listTaskAttachments(task.id).filter((attachment) => context.attachmentIds.includes(attachment.id));
  }

  private resolveAttachment(
    context: McpContextRecord,
    task: TaskRecord,
    attachmentId: string,
    kind?: AttachmentKind
  ): AttachmentRecord {
    if (!context.attachmentIds.includes(attachmentId)) {
      throw new SafeToolError('attachment_forbidden', '附件不属于当前任务能力范围。');
    }
    const attachment = this.authorizedAttachments(context, task).find((entry) => entry.id === attachmentId);
    if (!attachment || attachment.roomId !== context.roomId || attachment.userId !== context.userId) {
      throw new SafeToolError('attachment_forbidden', '附件归属校验失败。');
    }
    if (kind && attachment.kind !== kind) throw new SafeToolError('wrong_attachment_type', `附件类型必须是 ${kind}。`);
    return attachment;
  }

  private async verifyAttachment(
    context: McpContextRecord,
    task: TaskRecord,
    attachmentId: string,
    kind?: AttachmentKind
  ): Promise<AttachmentRecord> {
    const attachment = this.resolveAttachment(context, task, attachmentId, kind);
    try {
      return await this.fileService.verifyAttachment(attachment);
    } catch {
      throw new SafeToolError('attachment_integrity_failed', '附件路径、MIME、大小或哈希校验失败。');
    }
  }

  private resolveContext(
    contextId: string,
    allowReflection = false
  ): { context: McpContextRecord; task: TaskRecord } {
    const context = this.db.resolveMcpContext(contextId);
    if (!context) throw new SafeToolError('invalid_context', '任务权限已过期、被撤销或无效。');
    const task = this.db.getTask(context.taskId);
    if (!task || task.roomId !== context.roomId || task.userId !== context.userId || task.origin !== context.purpose) {
      throw new SafeToolError('context_mismatch', '任务权限和任务记录不匹配。');
    }
    if (['cancelled', 'failed', 'completed'].includes(task.status)) {
      throw new SafeToolError('task_finished', `任务已经结束：${task.status}`);
    }
    if (context.purpose === 'reflection' && !allowReflection) {
      throw new SafeToolError(
        'reflection_tool_forbidden',
        '反思 capability 只能调用作用域记忆工具。'
      );
    }
    const room = this.db.getRoomById(context.roomId);
    if (!room?.authorized || !room.enabled) throw new SafeToolError('room_disabled', '当前群未授权或未启用。');
    return { context, task };
  }

  private beginTaskOperation(taskId: string) {
    const controller = new AbortController();
    const controllers = this.activeControllers.get(taskId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.activeControllers.set(taskId, controllers);
    return {
      controller,
      done: () => {
        controllers.delete(controller);
        if (controllers.size === 0) this.activeControllers.delete(taskId);
      }
    };
  }

  private assertRate(kind: string, context: McpContextRecord, limit: number): void {
    const key = `${kind}:${context.roomId}:${context.userId}`;
    if (!this.limiter.allow(key, limit, 60_000)) throw new SafeToolError('rate_limited', `${kind} 工具调用过于频繁。`);
  }

  private assertGlobalRate(kind: string, limit: number): void {
    if (!this.limiter.allow(`global:${kind}`, limit, 60_000)) {
      throw new SafeToolError('rate_limited', `${kind} 全局调用达到供应商限额。`);
    }
  }

  private assertAdmin(context: McpContextRecord): void {
    const currentRole = this.db.getUserRole(context.roomId, context.userId);
    if (currentRole !== 'group_admin' && currentRole !== 'system_admin') {
      throw new SafeToolError('admin_required', '自动任务管理只允许群管理员或系统管理员。');
    }
  }

  private resolveAutomation(context: McpContextRecord, automationId: string) {
    const automation = this.db.getAutomation(automationId);
    if (!automation || automation.roomId !== context.roomId) throw new SafeToolError('automation_forbidden', '自动任务不存在或不属于当前群。');
    return automation;
  }

  private async handleMemoryBridge(pathname: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const session = this.resolveMemorySession(request);
    const body = await readJsonBody(request, 64 * 1024);
    if (pathname === '/internal/memory/prefetch') {
      return sendJson(response, 200, this.recallMemory(session.roomId, session.userId));
    }
    if (pathname === '/internal/memory/tool') {
      const name = typeof body.name === 'string' ? body.name : '';
      const args = body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments)
        ? body.arguments as Record<string, unknown>
        : {};
      const result = await this.handleProviderMemoryTool(session, name, args);
      return sendJson(response, 200, result);
    }
    if (pathname === '/internal/memory/turn') {
      if (session.purpose === 'interactive') {
        this.captureReflectionSignal(session.roomId, session.userId, body);
      }
      return sendJson(response, 200, { status: 'ok' });
    }
    return sendJson(response, 404, { error: 'not_found' });
  }

  private resolveMemorySession(request: IncomingMessage) {
    const raw = request.headers['x-hermes-session-key'];
    const sessionKey = Array.isArray(raw) ? raw[0] : raw;
    if (!sessionKey || sessionKey.length > 256) throw new SafeToolError('invalid_session', 'Hermes 会话身份无效。');
    const session = this.db.getHermesSessionByHash(sha256(sessionKey));
    if (!session) throw new SafeToolError('unknown_session', 'Hermes 会话未映射到 DangBot 作用域。');
    if (
      session.purpose === 'interactive' &&
      session.epoch !== this.db.getSessionEpoch(session.roomId, session.userId, 'interactive')
    ) {
      throw new SafeToolError('stale_session', 'Hermes 会话已轮换，旧会话不能重放。');
    }
    return session;
  }

  private recallMemory(roomId: string, userId: string) {
    const user = this.db.listMemories({ scope: 'user', roomId, userId, limit: this.config.limits.memoryEntriesPerUser });
    const room = this.db.listMemories({ scope: 'room', roomId, limit: this.config.limits.globalMemoryEntries });
    const lessons = this.db.listAgentLessons(20);
    const lines = [
      ...user.map((entry) => `[个人记忆 confidence=1 source=${entry.source}] ${entry.content}`),
      ...room.map((entry) => `[本群共享记忆 confidence=1 source=${entry.source}] ${entry.content}`),
      ...lessons.map((entry) => `[已批准 Agent 经验 confidence=${entry.confidence}] ${entry.content}`)
    ];
    return {
      status: 'ok',
      content: lines.join('\n'),
      data: {
        user: user.map(safeMemory),
        room: room.map(safeMemory),
        agentLessons: lessons.map(({ id, content, confidence }) => ({ id, content, confidence }))
      }
    };
  }

  private async memoryRecall(contextId: string): Promise<ToolPayload> {
    const { context } = this.resolveContext(contextId, true);
    const recalled = this.recallMemory(context.roomId, context.userId);
    return ok('已召回当前作用域记忆。', recalled.data);
  }

  private async memoryTool(
    contextId: string,
    name: 'dangbot_memory_propose' | 'dangbot_memory_feedback',
    args: Record<string, unknown>
  ): Promise<ToolPayload> {
    const { task } = this.resolveContext(contextId, true);
    const result = await this.performMemoryTool(task, name, args);
    return ok(result.summary, result.data);
  }

  private async handleProviderMemoryTool(
    session: HermesSessionRecord,
    name: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const { roomId, userId } = session;
    if (name === 'dangbot_memory_recall') return this.recallMemory(roomId, userId);
    const purpose = session.purpose === 'reflection' ? 'reflection' : 'interactive';
    const task = this.db.findLatestActiveTask(roomId, userId, purpose);
    if (!task) throw new SafeToolError('no_active_task', '当前会话没有可关联的活动任务。');
    return this.performMemoryTool(task, name, args);
  }

  private async performMemoryTool(
    task: TaskRecord,
    name: string,
    args: Record<string, unknown>
  ): Promise<MemoryToolResult> {
    const { roomId, userId } = task;
    if (name === 'dangbot_memory_feedback') {
      const signal = strictString(args.signal, 80, 'signal');
      const evidence = strictString(args.evidence, 4_000, 'evidence');
      this.db.addReflectionCandidate({ roomId, userId, taskId: task.id, signal, evidence });
      return { status: 'ok', summary: '反思信号已记录。' };
    }
    if (name !== 'dangbot_memory_propose') throw new SafeToolError('unknown_memory_tool', '未知记忆工具。');
    const scope = proposalScopeSchema.parse(args.scope) as MemoryProposalScope;
    const content = strictString(args.content, 2_000, 'content');
    const evidence = strictString(args.evidence, 4_000, 'evidence');
    const confidence = typeof args.confidence === 'number' ? args.confidence : 0;
    const auto = scope === 'user' && task.origin === 'reflection' && this.autoWriteEligible(task, content, evidence, confidence);
    const proposal = this.db.addMemoryProposal({
      scope,
      roomId,
      userId: scope === 'user' ? userId : undefined,
      content,
      evidence,
      confidence,
      status: auto ? 'auto_approved' : 'pending',
      proposerTaskId: task.id
    });
    if (auto) {
      this.db.addMemory({ scope: 'user', roomId, userId, source: `reflection:${proposal.id}`, content });
    }
    return {
      status: 'ok',
      summary: auto ? '个人记忆已按高置信规则自动写入。' : '记忆或经验提案已进入审批。',
      data: { proposalId: proposal.id, status: proposal.status, scope: proposal.scope }
    };
  }

  private autoWriteEligible(task: TaskRecord, content: string, evidence: string, confidence: number): boolean {
    if (confidence < this.config.reflection.autoWriteConfidence) return false;
    if (!isSupportedUserMemory(task.prompt, content, evidence)) return false;
    if (
      looksSensitive(content) ||
      looksSensitive(evidence) ||
      looksTemporary(content) ||
      looksTemporary(evidence)
    ) return false;
    const alreadyAutoWritten = this.db
      .listMemoryProposals({ roomId: task.roomId, userId: task.userId, limit: 100 })
      .some((proposal) => proposal.proposerTaskId === task.id && proposal.status === 'auto_approved');
    if (alreadyAutoWritten) return false;
    const existing = this.db.listMemories({ scope: 'user', roomId: task.roomId, userId: task.userId, limit: this.config.limits.memoryEntriesPerUser });
    const normalized = normalizeMemory(content);
    return !existing.some((entry) => normalizeMemory(entry.content) === normalized || isLikelyConflict(entry.content, content));
  }

  private captureReflectionSignal(roomId: string, userId: string, body: Record<string, unknown>): void {
    const userText = typeof body.userText === 'string' ? body.userText.slice(0, 4_000) : '';
    const assistantText = typeof body.assistantText === 'string' ? body.assistantText.slice(0, 4_000) : '';
    const task = this.db.findLatestActiveTask(roomId, userId) ?? this.db.listRoomTasks(roomId, 20).find((entry) => entry.userId === userId);
    if (!task) return;
    const signal = /不是|不对|纠正|应该是|我希望|以后请/u.test(userText)
      ? 'user_correction_or_preference'
      : /工具.{0,20}(失败|恢复|重试成功)/u.test(assistantText)
        ? 'tool_recovery'
        : undefined;
    if (signal) this.db.addReflectionCandidate({ roomId, userId, taskId: task.id, signal, evidence: userText || assistantText });
  }

  private async mcpResult(work: () => Promise<unknown>) {
    try {
      const payload = await work();
      return {
        content: [{
          type: 'text' as const,
          text: serializeMcpPayload(payload, this.config.limits.maxMcpOutputChars)
        }]
      };
    } catch (error) {
      const code = error instanceof SafeToolError ? error.code : 'tool_failed';
      return {
        isError: true,
        content: [{
          type: 'text' as const,
          text: serializeMcpPayload(
            { status: 'error', summary: safeErrorMessage(error), artifactIds: [], data: { code } },
            this.config.limits.maxMcpOutputChars
          )
        }]
      };
    }
  }

  private authorized(request: IncomingMessage, secret: string): boolean {
    const header = request.headers.authorization ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
    return timingSafeEqual(createHash('sha256').update(secret).digest(), createHash('sha256').update(provided).digest());
  }
}

class SafeToolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function ok(summary: string, data: unknown = null): ToolPayload {
  return { status: 'ok', summary, artifactIds: [], data: sanitizeData(data) };
}

function safeAttachment(attachment: AttachmentRecord) {
  return {
    id: attachment.id,
    name: attachment.fileName,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    sha256: attachment.hash,
    kind: attachment.kind,
    expiresAt: attachment.expiresAt
  };
}

function toMedia(attachment: AttachmentRecord): DashScopeMediaInput {
  return { filePath: attachment.filePath, mimeType: attachment.mimeType };
}

function validateVideoRoute(
  mode: Exclude<DashScopeVideoMode, 'auto'>,
  frame: DashScopeMediaInput | undefined,
  references: DashScopeMediaInput[],
  source: DashScopeMediaInput | undefined
): void {
  if (mode === 'text-to-video' && (frame || references.length > 0 || source)) throw new SafeToolError('invalid_video_route', '文生视频不能携带图片或源视频。');
  if (mode === 'image-to-video' && (!frame || references.length > 0 || source)) throw new SafeToolError('invalid_video_route', '单图首帧模式必须且只能提供 frameImageId。');
  if (mode === 'reference-to-video' && (references.length < 2 || frame || source)) throw new SafeToolError('invalid_video_route', '多图参考模式需要至少两张 referenceImageIds，且不能提供首帧或源视频。');
  if (mode === 'video-edit' && (!source || frame)) throw new SafeToolError('invalid_video_route', '视频编辑模式必须提供 sourceVideoId，不能提供 frameImageId。');
  if (mode === 'video-edit' && references.length > 5) throw new SafeToolError('invalid_video_route', '视频编辑最多允许五张参考图。');
}

function modelForVideoRoute(config: AppConfig, mode: Exclude<DashScopeVideoMode, 'auto'>): string {
  return {
    'text-to-video': config.media.videoModels.textToVideo,
    'image-to-video': config.media.videoModels.imageToVideo,
    'reference-to-video': config.media.videoModels.referenceToVideo,
    'video-edit': config.media.videoModels.videoEdit
  }[mode];
}

function safeAutomation(automation: AutomationRecord) {
  return {
    id: automation.id,
    name: automation.name,
    kind: automation.kind,
    scheduleType: automation.scheduleType,
    schedule: JSON.parse(automation.scheduleSpecJson) as unknown,
    timezone: automation.timezone,
    prompt: automation.prompt,
    status: automation.status,
    nextRunAt: automation.nextRunAt
  };
}

function safeMemory(memory: { id: string; content: string; source: string; updatedAt: string }) {
  return { id: memory.id, content: memory.content, source: memory.source, updatedAt: memory.updatedAt };
}

function strictString(value: unknown, max: number, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new SafeToolError('invalid_input', `${name} 必须是非空字符串且不超过 ${max} 字符。`);
  return value.trim();
}

function sanitizeData(
  value: unknown,
  depth = 0,
  maxStringChars = 8_000,
  collectionLimit = 100
): unknown {
  if (value === undefined || value === null) return null;
  if (depth > 6) return '[truncated]';
  if (typeof value === 'string') return redactHostPaths(value).slice(0, maxStringChars);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value
      .slice(0, collectionLimit)
      .map((entry) => sanitizeData(entry, depth + 1, maxStringChars, collectionLimit));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, collectionLimit)
        .map(([key, entry]) => [
          key.slice(0, 100),
          sanitizeData(entry, depth + 1, maxStringChars, collectionLimit)
        ])
    );
  }
  return String(value).slice(0, Math.min(1_000, maxStringChars));
}

function redactHostPaths(value: string): string {
  return redactSensitiveText(value, 8_000);
}

function safeErrorMessage(error: unknown): string {
  return safeErrorSummary(error, 1_000);
}

function looksSensitive(value: string): boolean {
  return /(sk-[A-Za-z0-9._-]{12,}|api\s*key|token|密码|身份证|银行卡|cookie|手机号|电话号码|家庭住址|邮箱|病史|诊断|药物|工资|账户|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|(?:\+?86[- ]?)?1[3-9]\d{9}|\d{15,19})/iu.test(value);
}

function looksTemporary(value: string): boolean {
  return /(今天|明天|刚才|现在|本周|临时|这次|当前状态)/u.test(value);
}

function normalizeMemory(value: string): string {
  return value.toLowerCase().replace(/[\s，。！？、,.!?]/gu, '');
}

function isLikelyConflict(existing: string, proposed: string): boolean {
  const negation = /(不|不要|别|禁止)/u;
  const left = normalizeMemory(existing);
  const right = normalizeMemory(proposed);
  if (left === right) return false;
  if (left.slice(0, 6) === right.slice(0, 6)) return true;
  const opposingPairs = [
    ['简短', '详细'],
    ['中文', '英文'],
    ['正式', '随意'],
    ['主动', '被动'],
    ['公开', '私密']
  ];
  if (opposingPairs.some(([a, b]) => (left.includes(a!) && right.includes(b!)) || (left.includes(b!) && right.includes(a!)))) {
    return true;
  }
  const withoutNegation = (value: string) => value.replace(/[不别禁止要]/gu, '');
  return (
    negation.test(existing) !== negation.test(proposed) &&
    longestCommonPrefix(withoutNegation(left), withoutNegation(right)) >= 4
  );
}

function isSupportedUserMemory(
  reflectionPrompt: string,
  content: string,
  evidence: string
): boolean {
  const quote = evidence.trim();
  const normalizedQuote = normalizeMemory(quote);
  const normalizedContent = normalizeMemory(content);
  if (normalizedQuote.length < 6 || normalizedContent.length < 4) return false;
  const userBlocks = [...reflectionPrompt.matchAll(/用户原话：([\s\S]*?)(?=\n当时最终回答：|\n\n记录\s+\d+|\n\n候选\s+\d+|$)/gu)]
    .map((match) => match[1]?.trim() ?? '')
    .filter(Boolean);
  if (!userBlocks.some((block) => block.includes(quote))) return false;
  return (
    normalizedQuote.includes(normalizedContent) ||
    normalizedContent.includes(normalizedQuote)
  );
}

function serializeMcpPayload(value: unknown, maxChars: number): string {
  const budget = Math.max(1_024, maxChars);
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  const status = record.status === 'ok' ? 'ok' : 'error';
  const rawSummary = typeof record.summary === 'string' ? redactHostPaths(record.summary) : '';
  const rawArtifactIds = Array.isArray(record.artifactIds)
    ? record.artifactIds.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const initial = JSON.stringify({
    status,
    summary: rawSummary,
    artifactIds: rawArtifactIds,
    data: sanitizeData(record.data)
  });
  if (initial.length <= budget) return initial;

  const summary = `${rawSummary.slice(0, Math.min(1_000, Math.floor(budget / 4)))}（数据已按安全上限截断）`;
  const artifactLimits = [...new Set([rawArtifactIds.length, 20, 10, 5, 1, 0])]
    .filter((limit) => limit <= rawArtifactIds.length);
  for (const artifactLimit of artifactLimits) {
    for (const collectionLimit of [100, 50, 20, 10, 5, 2, 1, 0]) {
      let low = 0;
      let high = 8_000;
      let best: string | undefined;
      while (low <= high) {
        const stringLimit = Math.floor((low + high) / 2);
        const candidate = JSON.stringify({
          status,
          summary,
          artifactIds: rawArtifactIds.slice(0, artifactLimit),
          data: sanitizeData(record.data, 0, stringLimit, collectionLimit)
        });
        if (candidate.length <= budget) {
          best = candidate;
          low = stringLimit + 1;
        } else {
          high = stringLimit - 1;
        }
      }
      if (best) return best;
    }
  }
  return JSON.stringify({
    status,
    summary: '工具输出超过安全上限，详细数据已截断。',
    artifactIds: [],
    data: { truncated: true }
  });
}

function longestCommonPrefix(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new SafeToolError('payload_too_large', '请求体过大。');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new SafeToolError('invalid_json', '请求体必须是有效 JSON 对象。');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SafeToolError('invalid_json', '请求体必须是 JSON 对象。');
  return parsed as Record<string, unknown>;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function unauthorized(response: ServerResponse): void {
  response.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' });
  response.end(JSON.stringify({ error: 'unauthorized' }));
}

function methodNotAllowed(response: ServerResponse): void {
  response.writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: 'method_not_allowed' }));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function isLoopbackUrl(value: string): boolean {
  try {
    return isLoopbackHost(new URL(value).hostname);
  } catch {
    return false;
  }
}
