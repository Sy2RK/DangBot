import { createHash, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse
} from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { Logger } from 'pino';
import type { AppConfig, McpContextRecord, TaskRecord } from '../../types.js';
import type { AppDatabase } from '../../storage/database.js';
import type { FileService } from '../files/fileService.js';
import type { OpenAICompatibleClient } from '../llm/openaiCompatibleClient.js';
import type { WebSearchClient } from '../search/braveSearchClient.js';
import type { ArtifactBroker } from '../artifacts/artifactBroker.js';
import type { PortableCodeSandbox } from '../sandbox/portableCodeSandbox.js';
import { createBuiltinToolRegistry } from '../../tools/builtin.js';
import { ToolPolicyEngine } from '../../tools/policy.js';
import { previewToolResult, stringifyToolInput, type ToolResult } from '../../tools/registry.js';
import { nowIso } from '../../utils/time.js';

const contextIdSchema = z.string().min(32).max(128);

export class DangBotMcpServer {
  private httpServer?: HttpServer;
  private readonly activeControllers = new Map<string, Set<AbortController>>();
  private readonly registry = createBuiltinToolRegistry();
  private readonly policy: ToolPolicyEngine;

  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
    private readonly llm: OpenAICompatibleClient,
    private readonly fileService: FileService,
    private readonly artifactBroker: ArtifactBroker,
    private readonly sandbox: PortableCodeSandbox,
    private readonly logger: Logger,
    private readonly systemPrompt: string,
    private readonly webSearch?: WebSearchClient
  ) {
    this.policy = new ToolPolicyEngine(config);
  }

  configured(): boolean {
    return Boolean(
      this.config.agent.mcp.enabled &&
      isLoopbackHost(this.config.agent.mcp.host) &&
      this.config.agent.mcp.apiKey.trim().length >= 32
    );
  }

  async start(): Promise<void> {
    if (!this.config.agent.mcp.enabled || this.httpServer) return;
    if (!isLoopbackHost(this.config.agent.mcp.host)) {
      throw new Error('DangBot MCP 只允许监听回环地址。');
    }
    if (this.config.agent.mcp.apiKey.trim().length < 32) {
      throw new Error('DangBot MCP API 密钥必须至少 32 个字符。');
    }

    this.db.cleanupExpiredMcpContexts();
    const server = createServer((request, response) => {
      void this.handleHttpRequest(request, response).catch((error) => {
        this.logger.error({ error }, 'MCP request failed');
        if (!response.headersSent) {
          response.writeHead(500, { 'Content-Type': 'application/json' });
        }
        response.end(JSON.stringify({ error: 'internal_error' }));
      });
    });
    this.httpServer = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.config.agent.mcp.port, this.config.agent.mcp.host);
    });
    this.logger.info(
      { host: this.config.agent.mcp.host, port: this.config.agent.mcp.port },
      'DangBot MCP started'
    );
  }

  async stop(): Promise<void> {
    for (const taskId of this.activeControllers.keys()) this.cancelTask(taskId);
    const server = this.httpServer;
    this.httpServer = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  boundPort(): number | undefined {
    const address = this.httpServer?.address();
    return address && typeof address === 'object' ? address.port : undefined;
  }

  cancelTask(taskId: string): void {
    for (const controller of this.activeControllers.get(taskId) ?? []) {
      controller.abort(new Error('DangBot task cancelled'));
    }
    this.activeControllers.delete(taskId);
    this.db.revokeMcpContext(taskId);
  }

  private async handleHttpRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/health' && request.method === 'GET') {
      if (!this.authorized(request)) return unauthorized(response);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok', sandbox: this.sandbox.configured() }));
      return;
    }
    if (url.pathname !== '/mcp') {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    if (!this.authorized(request)) return unauthorized(response);
    if (request.method !== 'POST') {
      response.writeHead(405, {
        Allow: 'POST',
        'Content-Type': 'application/json'
      });
      response.end(JSON.stringify({ error: 'method_not_allowed' }));
      return;
    }

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
    const server = new McpServer({ name: 'dangbot-safe-tools', version: '1.0.0' });

    server.registerTool(
      'dangbot_capabilities',
      {
        description: '列出 DangBot 为当前任务开放的受控工具。不会暴露宿主机路径或凭据。',
        inputSchema: { contextId: contextIdSchema }
      },
      async ({ contextId }) => this.mcpResult(() => this.capabilities(contextId))
    );

    server.registerTool(
      'dangbot_execute_tool',
      {
        description:
          '执行 DangBot 的受控文件、多模态、生成、语音或搜索工具。所有附件和产物都使用逻辑 ID；不能读写任意宿主机文件。',
        inputSchema: {
          contextId: contextIdSchema,
          toolName: z.string().min(1).max(100),
          input: z.record(z.string(), z.unknown()).default({})
        }
      },
      async ({ contextId, toolName, input }) =>
        this.mcpResult(() => this.executeRegisteredTool(contextId, toolName, input))
    );

    server.registerTool(
      'dangbot_list_memories',
      {
        description: '读取当前群和当前用户明确保存的记忆。不能读取其他群或其他用户。',
        inputSchema: { contextId: contextIdSchema }
      },
      async ({ contextId }) => this.mcpResult(() => this.listMemories(contextId))
    );

    server.registerTool(
      'dangbot_list_attachments',
      {
        description: '列出当前任务被授权使用的附件逻辑 ID 和安全元数据，不返回本机路径。',
        inputSchema: { contextId: contextIdSchema }
      },
      async ({ contextId }) => this.mcpResult(() => this.listAttachments(contextId))
    );

    server.registerTool(
      'dangbot_room_context',
      {
        description: '读取当前群最近的公开消息，用于群聊总结和指代理解。不能跨群读取。',
        inputSchema: {
          contextId: contextIdSchema,
          limit: z.number().int().min(1).max(40).default(20)
        }
      },
      async ({ contextId, limit }) => this.mcpResult(() => this.roomContext(contextId, limit))
    );

    server.registerTool(
      'dangbot_execute_javascript',
      {
        description:
          '在跨平台 QuickJS-WASM 沙箱运行纯 JavaScript 计算。没有 require、process、fetch、Shell 或宿主机文件系统；代码应显式 return 结果。',
        inputSchema: {
          contextId: contextIdSchema,
          code: z
            .string()
            .min(1)
            .max(64 * 1024)
        }
      },
      async ({ contextId, code }) => this.mcpResult(() => this.executeJavaScript(contextId, code))
    );

    return server;
  }

  private async capabilities(contextId: string): Promise<unknown> {
    const { context, task } = this.resolveContext(contextId);
    return {
      status: 'ok',
      summary: '当前任务可用的安全能力。',
      artifactIds: [],
      data: {
        taskId: task.id,
        tools: this.registry
          .list()
          .filter((definition) => this.toolAllowed(context, task, definition.name))
          .map((definition) => ({
            name: definition.name,
            description: definition.description,
            input: definition.inputDescription
          })),
        memory: 'explicit_scoped_only',
        javascriptSandbox: this.sandbox.configured(),
        hostShell: false,
        hostFileAccess: false
      }
    };
  }

  private async executeRegisteredTool(
    contextId: string,
    toolName: string,
    input: Record<string, unknown>
  ): Promise<unknown> {
    const { context, task } = this.resolveContext(contextId);
    const definition = this.registry.get(toolName);
    if (!definition) throw new Error(`未知 DangBot 工具：${toolName}`);
    this.assertToolAllowed(context, task, toolName);
    const parsedInput = this.registry.parseInput(definition, input);
    const attachments = this.db
      .listTaskAttachments(task.id)
      .filter((attachment) => context.attachmentIds.includes(attachment.id));
    const toolCall = this.db.createToolCall({
      taskId: task.id,
      roomId: context.roomId,
      userId: context.userId,
      toolName,
      riskLevel: definition.riskLevel,
      inputJson: stringifyToolInput(parsedInput)
    });
    this.db.updateToolCall(toolCall.id, { status: 'running', startedAt: nowIso() });

    const operation = this.beginTaskOperation(task.id);
    const controller = operation.controller;
    const timeout = setTimeout(
      () => controller.abort(),
      definition.timeoutMs ?? this.config.limits.agentTaskTimeoutMs
    );
    try {
      const result = await definition.execute(
        {
          config: this.config,
          db: this.db,
          llm: this.llm,
          fileService: this.fileService,
          webSearch: this.webSearch,
          logger: this.logger,
          task,
          role: context.role,
          attachments,
          system: { role: 'system', content: this.systemPrompt },
          signal: controller.signal,
          stage: async (message) => {
            this.db.addAudit({
              roomId: context.roomId,
              userId: context.userId,
              action: 'mcp_tool_progress',
              details: { taskId: task.id, toolName, message: message.slice(0, 300) }
            });
          },
          pickAttachment: (kind) => attachments.find((attachment) => attachment.kind === kind)
        },
        parsedInput
      );
      const run = this.db.getHermesRunByTask(task.id);
      const artifacts = await this.artifactBroker.registerToolResult(task.id, run?.runId, result);
      this.db.updateToolCall(toolCall.id, {
        status: 'completed',
        resultKind: result.kind,
        resultPreview: safeToolPreview(result, this.config.tools.policy.maxToolOutputChars),
        completedAt: nowIso()
      });
      return safeToolResponse(
        result,
        artifacts.map((artifact) => artifact.id),
        this.config.tools.policy.maxToolOutputChars
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.updateToolCall(toolCall.id, {
        status: controller.signal.aborted ? 'cancelled' : 'failed',
        error: message,
        completedAt: nowIso()
      });
      throw error;
    } finally {
      clearTimeout(timeout);
      operation.done();
    }
  }

  private async listMemories(contextId: string): Promise<unknown> {
    const { context } = this.resolveContext(contextId);
    const user = this.db.listMemories({
      scope: 'user',
      roomId: context.roomId,
      userId: context.userId,
      limit: this.config.limits.memoryEntriesPerUser
    });
    const global = this.db.listMemories({
      scope: 'global',
      roomId: context.roomId,
      limit: this.config.limits.globalMemoryEntries
    });
    return {
      status: 'ok',
      summary: `读取到 ${global.length} 条本群共享记忆和 ${user.length} 条个人记忆。`,
      artifactIds: [],
      data: {
        global: global.map(({ id, content, updatedAt }) => ({ id, content, updatedAt })),
        user: user.map(({ id, content, updatedAt }) => ({ id, content, updatedAt }))
      }
    };
  }

  private async listAttachments(contextId: string): Promise<unknown> {
    const { context, task } = this.resolveContext(contextId);
    const attachments = this.db
      .listTaskAttachments(task.id)
      .filter((attachment) => context.attachmentIds.includes(attachment.id));
    return {
      status: 'ok',
      summary: `当前任务有 ${attachments.length} 个授权附件。`,
      artifactIds: [],
      data: attachments.map((attachment) => ({
        id: attachment.id,
        name: attachment.fileName,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        kind: attachment.kind
      }))
    };
  }

  private async roomContext(contextId: string, limit: number): Promise<unknown> {
    const { context } = this.resolveContext(contextId);
    const messages = this.db.listRecentRoomMessages(context.roomId, limit);
    return {
      status: 'ok',
      summary: `读取到当前群最近 ${messages.length} 条公开消息。`,
      artifactIds: [],
      data: messages.map((message) => ({
        sender: this.db.getUserDisplayName(message.userId) ?? '群成员',
        text: message.text.slice(0, 4_000),
        mentionedBot: message.mentioned,
        createdAt: message.createdAt
      }))
    };
  }

  private async executeJavaScript(contextId: string, code: string): Promise<unknown> {
    const { context, task } = this.resolveContext(contextId);
    const operation = this.beginTaskOperation(task.id);
    let result;
    try {
      result = await this.sandbox.executeJavaScript(code, operation.controller.signal);
    } catch (error) {
      this.db.addAudit({
        roomId: context.roomId,
        userId: context.userId,
        action: 'portable_sandbox_rejected',
        details: {
          taskId: task.id,
          codeBytes: Buffer.byteLength(code),
          reason: error instanceof Error ? error.message.slice(0, 200) : 'sandbox_error'
        }
      });
      throw error;
    } finally {
      operation.done();
    }
    this.db.addAudit({
      roomId: context.roomId,
      userId: context.userId,
      action: 'portable_sandbox_executed',
      details: { taskId: task.id, codeBytes: Buffer.byteLength(code), truncated: result.truncated }
    });
    return {
      status: 'ok',
      summary: result.stdout || 'JavaScript 计算已完成。',
      artifactIds: [],
      data: { value: result.value, stdout: result.stdout, truncated: result.truncated }
    };
  }

  private resolveContext(contextId: string): { context: McpContextRecord; task: TaskRecord } {
    const context = this.db.resolveMcpContext(contextId);
    if (!context) throw new Error('任务权限已过期、被撤销或无效。');
    const task = this.db.getTask(context.taskId);
    if (!task || task.roomId !== context.roomId || task.userId !== context.userId) {
      throw new Error('任务权限和任务记录不匹配。');
    }
    if (['cancelled', 'failed', 'completed'].includes(task.status)) {
      throw new Error(`任务已经结束：${task.status}`);
    }
    return { context, task };
  }

  private beginTaskOperation(taskId: string): {
    controller: AbortController;
    done(): void;
  } {
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

  private toolAllowed(context: McpContextRecord, task: TaskRecord, toolName: string): boolean {
    try {
      this.assertToolAllowed(context, task, toolName);
      return true;
    } catch {
      return false;
    }
  }

  private assertToolAllowed(context: McpContextRecord, task: TaskRecord, toolName: string): void {
    const definition = this.registry.get(toolName);
    if (!definition) throw new Error(`未知工具：${toolName}`);
    if (toolName === 'web.search' && !this.config.search.enabled) {
      throw new Error('联网搜索未配置。');
    }
    if (toolName === 'web.search' && this.config.search.provider === 'hermes') {
      throw new Error('联网搜索由 Hermes 内建工具提供，不经 DangBot MCP。');
    }
    if (toolName === 'voice.generate' && !this.llm.speechConfigured()) {
      throw new Error('语音合成未配置。');
    }
    const room = this.db.getRoomById(context.roomId);
    if (!room?.authorized || !room.enabled) throw new Error('当前群未授权或未启用。');
    const decision = this.policy.evaluate({
      tool: definition,
      prompt: task.prompt,
      role: context.role,
      room,
      hasApprover: room.admins.length > 0 || this.config.auth.systemAdmins.length > 0
    });
    if (decision.action === 'deny') throw new Error(`工具被安全策略拒绝：${decision.reason}`);
    if (decision.action === 'require_approval' && !this.db.hasApprovedApproval(task.id, toolName)) {
      this.db.createApproval({
        taskId: task.id,
        roomId: task.roomId,
        requesterId: task.userId,
        riskType: 'mcp_tool_approval',
        reason: `Hermes 计划调用高风险工具 ${toolName}。`,
        toolName,
        toolInputJson: task.toolInputJson,
        policyReason: decision.reason
      });
      this.db.updateTask(task.id, { status: 'waiting_approval' });
      this.db.updateHermesRun(task.id, { status: 'waiting_for_approval' });
      throw new Error(
        `工具需要管理员单次审批：${toolName}。本次运行必须停止，批准后会重新执行任务。`
      );
    }
  }

  private async mcpResult(work: () => Promise<unknown>): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }> {
    try {
      const payload = await work();
      return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'error',
              summary: redactHostPaths(message),
              artifactIds: [],
              data: null
            })
          }
        ]
      };
    }
  }

  private authorized(request: IncomingMessage): boolean {
    const expected = hash(this.config.agent.mcp.apiKey);
    const header = request.headers.authorization ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
    const actual = hash(provided);
    return timingSafeEqual(expected, actual);
  }
}

function safeToolResponse(result: ToolResult, artifactIds: string[], maxChars: number): unknown {
  const text = redactHostPaths((result.summary ?? result.text ?? '').slice(0, maxChars));
  return {
    status: 'ok',
    summary: text || (artifactIds.length > 0 ? '产物已经生成。' : '工具执行完成。'),
    artifactIds,
    data: sanitizeMcpData(result.metadata)
  };
}

function safeToolPreview(result: ToolResult, maxChars: number): string {
  if (result.filePath || result.imagePath) {
    return (result.summary && !looksLikePath(result.summary) ? result.summary : '[artifact]').slice(
      0,
      maxChars
    );
  }
  return previewToolResult(result, maxChars);
}

function looksLikePath(value: string): boolean {
  return /(^|\s)(\/Users\/|\/home\/|[A-Za-z]:\\|file:\/\/)/.test(value);
}

function redactHostPaths(value: string): string {
  return value
    .replace(/(?:file:\/\/)?\/(?:Users|home|private|tmp)\/[^\s，。；;]+/g, '[host path redacted]')
    .replace(/[A-Za-z]:\\[^\s，。；;]+/g, '[host path redacted]');
}

function sanitizeMcpData(value: unknown, depth = 0): unknown {
  if (value === undefined || value === null) return null;
  if (depth > 6) return '[truncated]';
  if (typeof value === 'string') return redactHostPaths(value).slice(0, 8_000);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value))
    return value.slice(0, 100).map((entry) => sanitizeMcpData(entry, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 100)
        .map(([key, entry]) => [key.slice(0, 100), sanitizeMcpData(entry, depth + 1)])
    );
  }
  return String(value).slice(0, 1_000);
}

function unauthorized(response: ServerResponse): void {
  response.writeHead(401, {
    'Content-Type': 'application/json',
    'WWW-Authenticate': 'Bearer'
  });
  response.end(JSON.stringify({ error: 'unauthorized' }));
}

function hash(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}
