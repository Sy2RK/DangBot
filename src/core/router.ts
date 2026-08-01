import type { Logger } from 'pino';
import { parseCommand } from './parser.js';
import { refusalMessage, shouldRefusePrompt } from './security.js';
import { canUseCommand } from '../domain/permissions.js';
import { SlidingWindowRateLimiter } from '../domain/rateLimiter.js';
import {
  computeNextRunForAutomation,
  formatAutomationList,
  formatAutomationRunAt
} from '../domain/automations.js';
import type { TaskQueue } from '../domain/taskQueue.js';
import type { FileService } from '../services/files/fileService.js';
import type { ArtifactBroker } from '../services/artifacts/artifactBroker.js';
import type { HermesTaskExecutor } from '../services/hermes/hermesTaskExecutor.js';
import type { AppDatabase } from '../storage/database.js';
import { formatPlainList, normalizeOutgoingText, replyPhrases } from './replyStyle.js';
import type {
  AppConfig,
  AutomationRecord,
  AttachmentRecord,
  BotResponder,
  IncomingAttachment,
  IncomingMessage,
  ParsedCommand,
  TaskRecord,
  UserRole
} from '../types.js';
import { safeErrorSummary } from '../utils/redaction.js';

export class BotRequestRouter {
  private readonly limiter = new SlidingWindowRateLimiter();

  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
    private readonly queue: TaskQueue,
    private readonly fileService: FileService,
    private readonly artifactBroker: ArtifactBroker,
    private readonly logger: Logger,
    private readonly hermesExecutor: HermesTaskExecutor
  ) {}

  async handleMessage(message: IncomingMessage, responder: BotResponder): Promise<void> {
    const room = this.db.resolveRoom(message.roomId, message.roomTopic, {
      allowTopicBinding: this.config.auth.allowTopicRoomBinding
    });
    if (!room?.authorized) {
      this.db.addAudit({
        roomId: message.roomId,
        userId: message.senderId,
        action: 'unauthorized_room_message',
        details: { roomTopic: message.roomTopic, mentioned: message.mentioned }
      });
      return;
    }

    this.db.upsertUser(message.senderId, message.senderName);
    this.db.insertMessage({
      id: message.id,
      roomId: room.id,
      userId: message.senderId,
      text: message.mentioned ? message.mentionText : message.text,
      mentioned: message.mentioned,
      createdAt: message.timestamp.toISOString()
    });
    this.db.pruneRoomMessages(room.id, this.config.limits.publicContextMessagesPerRoom);

    if (!message.mentioned) {
      if (room.enabled) {
        const attachments = await this.materializeAttachments(message);
        if (attachments.length > 0) {
          await this.persistAttachments({ ...message, attachments }, room.id, responder, false);
        }
      }
      return;
    }

    const command = parseCommand(message.mentionText);
    const role = this.db.getUserRole(room.id, message.senderId);
    const adminless = room.admins.length === 0 && this.config.auth.systemAdmins.length === 0;
    const requesterCancellingOwnTask =
      command.type === 'cancel_task' && this.canCancelOwnTask(command, room.id, message.senderId);
    if (!requesterCancellingOwnTask && !canUseCommand(command, role, room, { adminless })) {
      await this.replyPlain(responder, permissionMessage(command, room.enabled));
      this.db.addAudit({
        roomId: room.id,
        userId: message.senderId,
        action: 'permission_denied',
        details: { command: command.type, role }
      });
      return;
    }

    switch (command.type) {
      case 'enable_room':
        this.db.setRoomEnabled(room.id, true);
        this.db.addAudit({ roomId: room.id, userId: message.senderId, action: 'room_enabled' });
        await this.replyPlain(responder, replyPhrases.roomEnabled);
        return;
      case 'disable_room':
        this.db.setRoomEnabled(room.id, false);
        this.db.addAudit({ roomId: room.id, userId: message.senderId, action: 'room_disabled' });
        await this.replyPlain(responder, replyPhrases.roomDisabled);
        return;
      case 'status':
        await this.replyStatus(room.id, responder);
        return;
      case 'health':
        await this.replyHealth(room.id, responder);
        return;
      case 'clear_user_context':
        this.db.rotateHermesSession(room.id, message.senderId);
        await this.replyPlain(responder, '你的 Hermes 会话已经换成全新一轮啦，旧会话不会再续接。');
        return;
      case 'clear_room_context':
        this.db.clearRoomMessages(room.id);
        await this.replyPlain(responder, replyPhrases.roomContextCleared);
        return;
      case 'remember_user':
        await this.rememberUser(command, room.id, message.senderId, responder);
        return;
      case 'remember_global':
        await this.rememberRoom(command, room.id, message.senderId, responder);
        return;
      case 'show_user_memory':
        await this.showMemory('user', room.id, message.senderId, responder);
        return;
      case 'show_global_memory':
        await this.showMemory('room', room.id, undefined, responder);
        return;
      case 'list_memory_proposals':
        await this.replyMemoryProposals(room.id, message.senderId, role, responder);
        return;
      case 'list_agent_lessons':
        await this.replyAgentLessons(responder);
        return;
      case 'revoke_agent_lesson':
        await this.revokeAgentLesson(command, room.id, message.senderId, responder);
        return;
      case 'delete_user_memory':
        await this.deleteUserMemory(command, room.id, message.senderId, responder);
        return;
      case 'clear_user_memory':
        this.db.clearMemories({ scope: 'user', roomId: room.id, userId: message.senderId });
        await this.replyPlain(responder, replyPhrases.userMemoryCleared);
        return;
      case 'clear_global_memory':
        this.db.clearMemories({ scope: 'room', roomId: room.id });
        await this.replyPlain(responder, replyPhrases.globalMemoryCleared);
        return;
      case 'create_automation':
        // Natural-language scheduling is an Agent task. Hermes must decide
        // whether and how to call the strict automation_create schema.
        await this.handleAgentRequest(command.rawText, message, room.id, responder);
        return;
      case 'list_automations':
        await this.replyPlain(responder, formatAutomationList(this.db.listRoomAutomations(room.id)));
        return;
      case 'pause_automation':
        await this.setAutomationStatus(command, room.id, message.senderId, 'paused', responder);
        return;
      case 'resume_automation':
        await this.setAutomationStatus(command, room.id, message.senderId, 'active', responder);
        return;
      case 'delete_automation':
        await this.deleteAutomation(command, room.id, message.senderId, responder);
        return;
      case 'cancel_task':
        await this.cancelTask(command, room.id, message.senderId, role, responder);
        return;
      case 'approve_task':
        await this.resolveApproval(command, room.id, message.senderId, true, responder);
        return;
      case 'reject_task':
        await this.resolveApproval(command, room.id, message.senderId, false, responder);
        return;
      case 'approve_memory_proposal':
        await this.resolveMemoryProposal(command, room.id, message.senderId, role, true, responder);
        return;
      case 'reject_memory_proposal':
        await this.resolveMemoryProposal(command, room.id, message.senderId, role, false, responder);
        return;
      case 'normal_request':
        await this.handleAgentRequest(command.prompt?.trim() ?? '', message, room.id, responder);
    }
  }

  async handleAutomationTrigger(automation: AutomationRecord, responder: BotResponder): Promise<void> {
    const current = this.db.getAutomation(automation.id);
    if (!current || current.status !== 'active') return;
    const task = this.db.createTask({
      roomId: current.roomId,
      userId: current.creatorId,
      origin: 'automation',
      prompt:
        current.kind === 'reminder'
          ? `到期提醒。请现在向群里提醒：${current.prompt}`
          : `到期自动任务。请现在执行：${current.prompt}`
    });
    this.db.addAudit({
      roomId: current.roomId,
      userId: current.creatorId,
      action: 'automation_task_created',
      details: { automationId: current.id, taskId: task.id }
    });
    await this.replyPlain(responder, `自动任务触发：${current.name}`);
    await this.enqueueTask(task, [], responder);
  }

  private async handleAgentRequest(
    prompt: string,
    message: IncomingMessage,
    roomId: string,
    responder: BotResponder
  ): Promise<void> {
    if (!prompt) {
      await this.replyPlain(responder, replyPhrases.emptyPrompt);
      return;
    }
    if (!this.allowGeneralRequest(roomId, message.senderId)) {
      await this.replyPlain(responder, replyPhrases.userRateLimited);
      return;
    }
    if (shouldRefusePrompt(prompt)) {
      this.db.addAudit({ roomId, userId: message.senderId, action: 'request_refused' });
      await this.replyPlain(responder, refusalMessage());
      return;
    }

    const incoming = await this.materializeAttachments(message);
    const persisted = incoming.length > 0
      ? await this.persistAttachments({ ...message, attachments: incoming }, roomId, responder)
      : [];
    if (persisted === undefined) return;

    const currentIds = new Set(persisted.map((attachment) => attachment.id));
    const recent = this.db
      .listRecentAttachments(roomId, message.senderId, 5)
      .filter((attachment) => !currentIds.has(attachment.id));
    const taskAttachments = [...persisted, ...recent];
    const task = this.db.createTask({
      roomId,
      userId: message.senderId,
      origin: 'interactive',
      prompt
    });
    this.db.linkTaskAttachments(task.id, taskAttachments);
    this.db.addAudit({
      roomId,
      userId: message.senderId,
      action: 'task_created',
      details: { taskId: task.id, origin: task.origin, attachmentCount: taskAttachments.length }
    });
    await this.replyPlain(responder, `${replyPhrases.progressReceived}\n任务号：${task.id}`);
    void this.enqueueTask(task, taskAttachments, responder).catch(() => undefined);
  }

  private enqueueTask(
    task: TaskRecord,
    attachments: AttachmentRecord[],
    responder: BotResponder
  ): Promise<void> {
    return this.queue.enqueue(
      task,
      async (signal) => {
        try {
          const result = await this.hermesExecutor.execute(task, attachments, signal, {
            stage: async (message) => this.replyPlain(responder, message)
          });
          const current = this.db.getTask(task.id);
          if (!current || current.status === 'cancelled' || signal.aborted) return;
          if (current.status === 'waiting_approval') {
            await this.replyPlain(
              responder,
              `任务 ${task.id} 暂停在安全审批点。管理员只能单次同意或拒绝。`
            );
            return;
          }
          await this.deliverResult(current, result.text, responder);
        } catch (error) {
          const current = this.db.getTask(task.id);
          if (current?.status === 'cancelled') return;
          const reason = safeErrorSummary(error, 500);
          await this.replyPlain(responder, replyPhrases.taskFailed(reason));
          throw error;
        }
      },
      false,
      this.config.agent.hermes.requestTimeoutMs + 30_000
    );
  }

  private async deliverResult(task: TaskRecord, rawText: string | undefined, responder: BotResponder): Promise<void> {
    const text = normalizeOutgoingText(rawText ?? '');
    const artifacts = this.db.listTaskArtifacts(task.id);
    if (text) {
      if (text.length <= this.config.limits.maxReplyTextChars) {
        await responder.replyText(text);
      } else {
        const filePath = await this.fileService.writeDocumentResult(`dangbot_${task.id}`, text, 'txt');
        await this.artifactBroker.registerToolResult(task.id, this.db.getHermesRunByTask(task.id)?.runId, { filePath });
        await this.replyPlain(responder, replyPhrases.longTextFile);
      }
    }

    const allArtifacts = this.db.listTaskArtifacts(task.id);
    for (const artifact of allArtifacts) {
      if (artifact.deliveredAt) continue;
      const verified = await this.artifactBroker.resolveForDelivery(artifact);
      if (verified.kind === 'image') {
        await responder.replyImage(verified.filePath, verified.displayName);
      } else {
        await responder.replyFile(verified.filePath, verified.displayName);
      }
      this.db.markArtifactDelivered(verified.id);
      this.db.addAudit({
        roomId: task.roomId,
        userId: task.userId,
        action: 'artifact_delivered',
        details: { taskId: task.id, artifactId: verified.id, kind: verified.kind }
      });
    }

    const finalArtifacts = this.db.listTaskArtifacts(task.id);
    const latest = finalArtifacts.at(-1);
    this.db.updateTask(task.id, {
      status: 'completed',
      resultKind: latest ? (latest.kind === 'image' ? 'image' : 'file') : 'text',
      resultText: text || undefined,
      resultPath: latest?.filePath
    });
    if (!text && finalArtifacts.length === 0) {
      await this.replyPlain(responder, replyPhrases.emptyTaskResult);
    }
    if (task.origin === 'interactive') {
      const notices = this.db.listUnnotifiedAutoMemoryProposals(task.roomId, task.userId);
      if (notices.length > 0) {
        await this.replyPlain(
          responder,
          [
            '顺便透明报备一下：上次反思中自动保存了这些高置信个人记忆：',
            ...notices.map((proposal, index) => `${index + 1}、${proposal.content}`),
            '你随时可以用“查看我的记忆”确认，或用“清空我的记忆”删除。'
          ].join('\n')
        );
        this.db.markMemoryProposalsNotified(notices.map((proposal) => proposal.id));
      }
      const role = this.db.getUserRole(task.roomId, task.userId);
      const pending = this.approvableMemoryProposals(task.roomId, task.userId, role);
      if (pending.length > 0) {
        await this.replyPlain(
          responder,
          `还有 ${pending.length} 条记忆或经验提案等你审批；回复“记忆提案”可查看 ID。`
        );
      }
    }
    if (artifacts.length > 0 && !text) {
      this.logger.debug({ taskId: task.id, artifactCount: artifacts.length }, 'artifact-only task delivered');
    }
  }

  private async cancelTask(
    command: ParsedCommand,
    roomId: string,
    userId: string,
    role: UserRole,
    responder: BotResponder
  ): Promise<void> {
    const task = this.findTask(command, roomId, (candidate) =>
      ['received', 'waiting_approval', 'processing'].includes(candidate.status)
    );
    if (!task || (task.userId !== userId && role === 'member')) {
      await this.replyPlain(responder, replyPhrases.noTaskToCancel);
      return;
    }
    this.db.updateTask(task.id, { status: 'cancelled', error: '用户或管理员取消' });
    this.queue.cancel(task.id);
    await this.hermesExecutor.stopTask(task.id);
    this.db.addAudit({ roomId, userId, action: 'task_cancelled', details: { taskId: task.id } });
    await this.replyPlain(responder, replyPhrases.taskCancelled);
  }

  private async resolveApproval(
    command: ParsedCommand,
    roomId: string,
    userId: string,
    approved: boolean,
    responder: BotResponder
  ): Promise<void> {
    const task = this.findTask(command, roomId, (candidate) => candidate.status === 'waiting_approval');
    if (!task) {
      await this.replyPlain(responder, replyPhrases.noApprovalTask);
      return;
    }
    if (!approved) {
      const denied = await this.hermesExecutor.approveTask(task.id, false);
      if (!denied) {
        await this.replyPlain(responder, '这个审批点已经失效，不能转成永久授权或绕过后重跑。');
        return;
      }
      this.db.resolveApproval(task.id, userId, false);
      this.db.updateTask(task.id, { status: 'cancelled', error: '管理员拒绝审批' });
      this.queue.cancel(task.id);
      await this.replyPlain(responder, replyPhrases.approvalRejected);
      return;
    }
    const continued = await this.hermesExecutor.approveTask(task.id, true);
    if (!continued) {
      await this.replyPlain(responder, '这个审批点已经失效，不能转成永久授权或绕过后重跑。');
      return;
    }
    this.db.resolveApproval(task.id, userId, true);
    this.db.updateTask(task.id, { status: 'processing' });
    await this.replyPlain(responder, replyPhrases.approvalAccepted);
  }

  private async resolveMemoryProposal(
    command: ParsedCommand,
    roomId: string,
    userId: string,
    role: UserRole,
    approved: boolean,
    responder: BotResponder
  ): Promise<void> {
    const proposal = command.proposalId ? this.db.getMemoryProposal(command.proposalId) : undefined;
    if (!proposal || proposal.roomId !== roomId || proposal.status !== 'pending') {
      await this.replyPlain(responder, '没找到仍在等待审批的记忆提案。');
      return;
    }
    const allowed =
      proposal.scope === 'user'
        ? proposal.userId === userId
        : proposal.scope === 'room'
          ? role === 'group_admin' || role === 'system_admin'
          : role === 'system_admin';
    if (!allowed) {
      await this.replyPlain(responder, '这个作用域的记忆提案不能由你审批。');
      return;
    }
    this.db.resolveMemoryProposal(proposal.id, approved, userId);
    await this.replyPlain(
      responder,
      approved ? `记忆提案 ${proposal.id} 已批准并写入对应作用域。` : `记忆提案 ${proposal.id} 已拒绝。`
    );
  }

  private async replyStatus(roomId: string, responder: BotResponder): Promise<void> {
    const room = this.db.getRoomById(roomId);
    await this.replyPlain(
      responder,
      [
        `猫猫状态：${room?.enabled ? '醒着' : '睡着'}`,
        'Agent 后端：专用 Hermes（唯一）',
        `队列：运行中 ${this.queue.runningCount()}，等待 ${this.queue.pendingCount()}`
      ].join('\n')
    );
  }

  private async replyHealth(roomId: string, responder: BotResponder): Promise<void> {
    let hermes = '不可访问';
    try {
      const health = await this.hermesExecutor.health(AbortSignal.timeout(2_000));
      hermes = String(health.status ?? 'ok');
    } catch (error) {
      hermes = safeErrorSummary(error, 300) || '不可访问';
    }
    const lines = [
      '小当自检完成，喵。',
      `本群：${this.db.getRoomById(roomId)?.enabled ? '已启用' : '未启用'}`,
      `专用 Hermes：${hermes}`,
      `主模型：${this.config.agent.hermes.model}`,
      `多模态：${this.config.media.multimodalModel}`,
      `图片：${this.config.media.imageModel}`,
      `视频：HappyHorse 按输入路由，并发 1`,
      `MCP：一等工具，宿主 Shell/任意文件写入关闭`,
      `记忆：分群分用户 Provider，Hermes 全局记忆关闭`
    ];
    await this.replyPlain(responder, lines.join('\n'));
  }

  private async rememberUser(command: ParsedCommand, roomId: string, userId: string, responder: BotResponder): Promise<void> {
    const content = command.memoryText?.trim();
    if (!content) {
      await this.replyPlain(responder, replyPhrases.askMemoryContent);
      return;
    }
    this.db.addMemory({ scope: 'user', roomId, userId, source: 'manual', content });
    await this.replyPlain(responder, replyPhrases.memorySaved);
  }

  private async rememberRoom(command: ParsedCommand, roomId: string, userId: string, responder: BotResponder): Promise<void> {
    const content = command.memoryText?.trim();
    if (!content) {
      await this.replyPlain(responder, replyPhrases.askGlobalMemoryContent);
      return;
    }
    this.db.addMemory({ scope: 'room', roomId, source: 'manual', content });
    this.db.addAudit({ roomId, userId, action: 'room_memory_saved' });
    await this.replyPlain(responder, replyPhrases.globalMemorySaved);
  }

  private async showMemory(
    scope: 'user' | 'room',
    roomId: string,
    userId: string | undefined,
    responder: BotResponder
  ): Promise<void> {
    const memories = this.db.listMemories({
      scope,
      roomId,
      userId,
      limit: scope === 'user' ? this.config.limits.memoryEntriesPerUser : this.config.limits.globalMemoryEntries
    });
    await this.replyPlain(
      responder,
      formatPlainList(
        scope === 'user' ? '你的记忆' : '本群共享记忆',
        memories.map((entry) => `${entry.id}：${entry.content}`)
      )
    );
  }

  private async deleteUserMemory(
    command: ParsedCommand,
    roomId: string,
    userId: string,
    responder: BotResponder
  ): Promise<void> {
    const deleted = command.memoryId
      ? this.db.deleteUserMemory(command.memoryId, roomId, userId)
      : false;
    await this.replyPlain(
      responder,
      deleted ? `个人记忆 ${command.memoryId} 已删除。` : '没找到属于你的这条个人记忆。'
    );
  }

  private approvableMemoryProposals(roomId: string, userId: string, role: UserRole) {
    return this.db
      .listMemoryProposals({ roomId, status: 'pending', limit: 50 })
      .filter((proposal) =>
        proposal.scope === 'user'
          ? proposal.userId === userId
          : proposal.scope === 'room'
            ? role === 'group_admin' || role === 'system_admin'
            : role === 'system_admin'
      );
  }

  private async replyMemoryProposals(
    roomId: string,
    userId: string,
    role: UserRole,
    responder: BotResponder
  ): Promise<void> {
    const proposals = this.approvableMemoryProposals(roomId, userId, role);
    await this.replyPlain(
      responder,
      formatPlainList(
        '待你审批的记忆提案',
        proposals.map(
          (proposal) =>
            `${proposal.id} [${proposal.scope}, confidence=${proposal.confidence.toFixed(2)}] ${proposal.content}`
        ),
        '目前没有需要你审批的记忆提案。'
      )
    );
  }

  private async replyAgentLessons(responder: BotResponder): Promise<void> {
    const lessons = this.db.listAgentLessons(100);
    await this.replyPlain(
      responder,
      formatPlainList(
        '已批准的跨群 Agent 经验',
        lessons.map(
          (lesson) =>
            `${lesson.id} [confidence=${lesson.confidence.toFixed(2)}] ${lesson.content}`
        ),
        '目前没有生效中的跨群 Agent 经验。'
      )
    );
  }

  private async revokeAgentLesson(
    command: ParsedCommand,
    roomId: string,
    userId: string,
    responder: BotResponder
  ): Promise<void> {
    const revoked = command.lessonId ? this.db.revokeAgentLesson(command.lessonId) : false;
    if (revoked) {
      this.db.addAudit({
        roomId,
        userId,
        action: 'agent_lesson_revoked',
        details: { lessonId: command.lessonId }
      });
    }
    await this.replyPlain(
      responder,
      revoked
        ? `跨群 Agent 经验 ${command.lessonId} 已撤销，之后不会再召回。`
        : '没找到仍在生效的这条 Agent 经验。'
    );
  }

  private async setAutomationStatus(
    command: ParsedCommand,
    roomId: string,
    userId: string,
    status: 'active' | 'paused',
    responder: BotResponder
  ): Promise<void> {
    const automation = this.getRoomAutomation(command, roomId);
    if (!automation) {
      await this.replyPlain(responder, '没找到这只小闹钟。');
      return;
    }
    const nextRunAt = status === 'active' ? computeNextRunForAutomation(automation) : automation.nextRunAt;
    this.db.updateAutomation(automation.id, { status, nextRunAt });
    this.db.addAudit({ roomId, userId, action: `automation_${status}`, details: { automationId: automation.id } });
    await this.replyPlain(
      responder,
      status === 'active'
        ? `自动任务已恢复。下次：${formatAutomationRunAt(nextRunAt, automation.timezone)}`
        : '自动任务已暂停。'
    );
  }

  private async deleteAutomation(command: ParsedCommand, roomId: string, userId: string, responder: BotResponder): Promise<void> {
    const automation = this.getRoomAutomation(command, roomId);
    if (!automation) {
      await this.replyPlain(responder, '没找到这只小闹钟。');
      return;
    }
    this.db.deleteAutomation(automation.id);
    this.db.addAudit({ roomId, userId, action: 'automation_deleted', details: { automationId: automation.id } });
    await this.replyPlain(responder, `自动任务 ${automation.id} 已删除。`);
  }

  private getRoomAutomation(command: ParsedCommand, roomId: string): AutomationRecord | undefined {
    if (command.automationId) {
      const automation = this.db.getAutomation(command.automationId);
      return automation?.roomId === roomId ? automation : undefined;
    }
    return command.automationIndex
      ? this.db.listRoomAutomations(roomId).at(command.automationIndex - 1)
      : undefined;
  }

  private findTask(
    command: ParsedCommand,
    roomId: string,
    predicate: (task: TaskRecord) => boolean
  ): TaskRecord | undefined {
    if (command.taskId) {
      const task = this.db.getTask(command.taskId);
      return task?.roomId === roomId && predicate(task) ? task : undefined;
    }
    return this.db.listRoomTasks(roomId, 20).find(predicate);
  }

  private canCancelOwnTask(command: ParsedCommand, roomId: string, userId: string): boolean {
    const task = this.findTask(command, roomId, (candidate) => ['received', 'waiting_approval', 'processing'].includes(candidate.status));
    return task?.userId === userId;
  }

  private allowGeneralRequest(roomId: string, userId: string): boolean {
    if (!this.limiter.allow(`user:${roomId}:${userId}`, this.config.limits.userRequestsPerMinute, 60_000)) return false;
    return this.limiter.allow(`room:${roomId}`, this.config.limits.roomRequestsPerMinute, 60_000);
  }

  private async materializeAttachments(message: IncomingMessage): Promise<IncomingAttachment[]> {
    if (message.attachments.length > 0 || !message.loadAttachments) return message.attachments;
    const attachments = await message.loadAttachments();
    message.attachments = attachments;
    return attachments;
  }

  private async persistAttachments(
    message: IncomingMessage,
    roomId: string,
    responder: BotResponder,
    notify = true
  ): Promise<AttachmentRecord[] | undefined> {
    const records: AttachmentRecord[] = [];
    for (const attachment of message.attachments) {
      try {
        await this.fileService.validateAttachment(attachment);
        const record = await this.fileService.toAttachmentRecord({
          attachment,
          roomId,
          userId: message.senderId,
          messageId: message.id
        });
        this.db.addAttachment(record);
        records.push(record);
      } catch (error) {
        const reason = safeErrorSummary(error, 500);
        if (notify) await this.replyPlain(responder, replyPhrases.attachmentRejected(reason));
        this.db.addAudit({ roomId, userId: message.senderId, action: 'attachment_rejected', details: { reason } });
        return notify ? undefined : records;
      }
    }
    return records;
  }

  private async replyPlain(responder: BotResponder, text: string): Promise<string> {
    const plain = normalizeOutgoingText(text);
    await responder.replyText(plain);
    return plain;
  }
}

function permissionMessage(command: ParsedCommand, roomEnabled: boolean): string {
  if (!roomEnabled && command.type === 'normal_request') return replyPhrases.roomNotEnabled;
  if (command.type === 'list_agent_lessons' || command.type === 'revoke_agent_lesson') {
    return '这个操作只允许系统管理员使用。';
  }
  return '这个操作需要群管理员或系统管理员权限。';
}
