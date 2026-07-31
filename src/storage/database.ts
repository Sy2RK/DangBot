import DatabaseConstructor, { type Database } from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type {
  AppConfig,
  AttachmentRecord,
  RequestKind,
  ResultKind,
  RoomConfig,
  RoomState,
  TaskRecord,
  TaskStatus,
  UserRole,
  AttachmentKind,
  MemoryRecord,
  MemoryScope,
  ToolCallRecord,
  ToolCallStatus,
  ToolResultKind,
  ToolRiskLevel,
  AutomationKind,
  AutomationRecord,
  AutomationScheduleType,
  AutomationStatus,
  ArtifactKind,
  ArtifactRecord,
  HermesRunRecord,
  HermesRunStatus,
  McpContextRecord
} from '../types.js';
import { ensureParentDir } from '../utils/fs.js';
import { nowIso } from '../utils/time.js';

export class AppDatabase {
  private readonly db: Database;

  private constructor(db: Database) {
    this.db = db;
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  static async open(filePath: string): Promise<AppDatabase> {
    await ensureParentDir(filePath);
    const db = new DatabaseConstructor(filePath);
    const appDb = new AppDatabase(db);
    appDb.migrate();
    return appDb;
  }

  static memory(): AppDatabase {
    const appDb = new AppDatabase(new DatabaseConstructor(':memory:'));
    appDb.migrate();
    return appDb;
  }

  close(): void {
    this.db.close();
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        topic TEXT,
        enabled INTEGER NOT NULL DEFAULT 0,
        authorized INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS room_bindings (
        runtime_id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        topic TEXT,
        source TEXT NOT NULL DEFAULT 'config',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE ON UPDATE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_room_bindings_room ON room_bindings(room_id);

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        display_name TEXT,
        role TEXT NOT NULL DEFAULT 'member',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS room_members (
        room_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (room_id, user_id),
        FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE ON UPDATE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        text TEXT,
        mentioned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_room_created ON messages(room_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_user_created ON messages(room_id, user_id, created_at);

      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        message_id TEXT,
        file_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        hash TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_attachments_recent
        ON attachments(room_id, user_id, kind, created_at);

      CREATE TABLE IF NOT EXISTS task_attachments (
        task_id TEXT NOT NULL,
        attachment_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (task_id, attachment_id),
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        request_type TEXT NOT NULL,
        status TEXT NOT NULL,
        prompt TEXT NOT NULL,
        tool_name TEXT,
        tool_input_json TEXT,
        result_kind TEXT,
        result_text TEXT,
        result_path TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_room_status ON tasks(room_id, status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_user_created ON tasks(room_id, user_id, created_at);

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        requester_id TEXT NOT NULL,
        risk_type TEXT NOT NULL,
        status TEXT NOT NULL,
        approver_id TEXT,
        reason TEXT,
        tool_name TEXT,
        tool_input_json TEXT,
        policy_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS tool_calls (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        status TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        input_json TEXT NOT NULL,
        result_kind TEXT,
        result_preview TEXT,
        error TEXT,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_tool_calls_task ON tool_calls(task_id, created_at);

      CREATE TABLE IF NOT EXISTS hermes_runs (
        task_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        session_key_hash TEXT NOT NULL,
        context_id_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_hermes_runs_status ON hermes_runs(status, updated_at);

      CREATE TABLE IF NOT EXISTS mcp_contexts (
        token_hash TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE,
        room_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        attachment_ids_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_mcp_contexts_expiry ON mcp_contexts(expires_at, revoked_at);

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        run_id TEXT,
        kind TEXT NOT NULL,
        file_path TEXT NOT NULL,
        display_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        delivered_at TEXT,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_run_hash
        ON artifacts(run_id, sha256) WHERE run_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS automations (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        creator_id TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        request_type TEXT NOT NULL,
        schedule_type TEXT NOT NULL,
        schedule_spec_json TEXT NOT NULL,
        timezone TEXT NOT NULL,
        prompt TEXT NOT NULL,
        tool_name TEXT,
        tool_input_json TEXT,
        status TEXT NOT NULL,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_run_at TEXT,
        next_run_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_automations_due ON automations(status, next_run_at);
      CREATE INDEX IF NOT EXISTS idx_automations_room ON automations(room_id, created_at);

      CREATE TABLE IF NOT EXISTS contexts (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        room_id TEXT NOT NULL,
        user_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_contexts_scope_created
        ON contexts(scope, room_id, user_id, created_at);

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        room_id TEXT NOT NULL,
        user_id TEXT,
        source TEXT NOT NULL DEFAULT 'manual',
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memories_scope_updated
        ON memories(scope, room_id, user_id, updated_at);

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        room_id TEXT,
        user_id TEXT,
        action TEXT NOT NULL,
        details TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
    `);
    this.ensureColumn('tasks', 'tool_name', 'TEXT');
    this.ensureColumn('tasks', 'tool_input_json', 'TEXT');
    this.ensureColumn('approvals', 'tool_name', 'TEXT');
    this.ensureColumn('approvals', 'tool_input_json', 'TEXT');
    this.ensureColumn('approvals', 'policy_reason', 'TEXT');
    this.ensureColumn('automations', 'request_type', "TEXT NOT NULL DEFAULT 'qa'");
    this.ensureColumn('memories', 'source', "TEXT NOT NULL DEFAULT 'manual'");
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memories_source
        ON memories(scope, room_id, user_id, source);
    `);
    this.db.exec(`
      INSERT OR IGNORE INTO room_bindings (
        runtime_id, room_id, topic, source, created_at, updated_at
      )
      SELECT id, id, topic, 'legacy', created_at, updated_at
      FROM rooms
      WHERE id NOT LIKE 'topic:%';
    `);
  }

  seedConfig(config: AppConfig): void {
    const tx = this.db.transaction(() => {
      const now = nowIso();
      this.db.prepare('UPDATE rooms SET authorized = 0, enabled = 0, updated_at = ?').run(now);
      this.db
        .prepare(
          "UPDATE room_members SET role = 'member', updated_at = ? WHERE role = 'group_admin'"
        )
        .run(now);
      this.db
        .prepare("UPDATE users SET role = 'member', updated_at = ? WHERE role = 'system_admin'")
        .run(now);

      for (const adminId of config.auth.systemAdmins) {
        this.upsertUser(adminId, undefined, 'system_admin');
      }

      for (const roomConfig of config.auth.rooms) {
        this.upsertConfiguredRoom(roomConfig);
      }
    });
    tx();
  }

  upsertConfiguredRoom(roomConfig: RoomConfig): RoomState {
    const now = nowIso();
    const roomId =
      roomConfig.stableId ?? roomConfig.id ?? `topic:${roomConfig.topic ?? randomUUID()}`;
    this.db
      .prepare(
        `
        INSERT INTO rooms (id, topic, enabled, authorized, created_at, updated_at)
        VALUES (@id, @topic, @enabled, 1, @now, @now)
        ON CONFLICT(id) DO UPDATE SET
          topic = COALESCE(excluded.topic, rooms.topic),
          enabled = excluded.enabled,
          authorized = 1,
          updated_at = excluded.updated_at
      `
      )
      .run({
        id: roomId,
        topic: roomConfig.topic,
        enabled: roomConfig.enabled ? 1 : 0,
        now
      });

    const runtimeIds = new Set(
      [roomConfig.id, ...(roomConfig.runtimeIds ?? [])].filter((runtimeId): runtimeId is string =>
        Boolean(runtimeId)
      )
    );
    for (const runtimeId of runtimeIds) {
      this.mergeRoomData(runtimeId, roomId);
      this.upsertRoomBinding(runtimeId, roomId, roomConfig.topic, 'config');
    }

    for (const adminId of roomConfig.admins) {
      this.upsertUser(adminId, undefined, 'member');
      this.setRoomMemberRole(roomId, adminId, 'group_admin');
    }

    return this.getRoomById(roomId)!;
  }

  resolveRoom(
    roomId: string,
    topic?: string,
    options: { allowTopicBinding?: boolean } = {}
  ): RoomState | undefined {
    const boundRoom = this.getRoomByRuntimeId(roomId);
    if (boundRoom) {
      if (topic && boundRoom.topic !== topic) {
        this.db
          .prepare('UPDATE rooms SET topic = ?, updated_at = ? WHERE id = ?')
          .run(topic, nowIso(), boundRoom.id);
        this.upsertRoomBinding(roomId, boundRoom.id, topic, 'observed');
        return this.getRoomById(boundRoom.id);
      }
      return boundRoom;
    }

    let room = this.getRoomById(roomId);
    if (room) {
      if (topic && room.topic !== topic) {
        this.db
          .prepare('UPDATE rooms SET topic = ?, updated_at = ? WHERE id = ?')
          .run(topic, nowIso(), roomId);
        room = this.getRoomById(roomId);
      }
      if (!room) return undefined;
      this.upsertRoomBinding(roomId, room.id, topic ?? room.topic, 'legacy');
      return room;
    }

    if (!topic || !options.allowTopicBinding) return undefined;
    const candidates = this.db
      .prepare('SELECT * FROM rooms WHERE topic = ? AND authorized = 1 ORDER BY created_at')
      .all(topic) as DbRoom[];
    if (candidates.length !== 1) return undefined;

    const byTopic = candidates[0];
    if (!byTopic) return undefined;
    this.upsertRoomBinding(roomId, byTopic.id, topic, 'topic');
    return normalizeRoom(byTopic, this.getRoomAdmins(byTopic.id));
  }

  getRoomById(roomId: string): RoomState | undefined {
    const row = this.db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId) as
      | DbRoom
      | undefined;
    if (!row) return undefined;
    return normalizeRoom(row, this.getRoomAdmins(roomId));
  }

  private getRoomByRuntimeId(runtimeId: string): RoomState | undefined {
    const row = this.db
      .prepare(
        `
        SELECT rooms.*
        FROM room_bindings
        JOIN rooms ON rooms.id = room_bindings.room_id
        WHERE room_bindings.runtime_id = ?
      `
      )
      .get(runtimeId) as DbRoom | undefined;
    if (!row) return undefined;
    return normalizeRoom(row, this.getRoomAdmins(row.id));
  }

  private upsertRoomBinding(
    runtimeId: string,
    roomId: string,
    topic: string | undefined,
    source: 'config' | 'legacy' | 'observed' | 'topic'
  ): void {
    const now = nowIso();
    this.db
      .prepare(
        `
        INSERT INTO room_bindings (runtime_id, room_id, topic, source, created_at, updated_at)
        VALUES (@runtimeId, @roomId, @topic, @source, @now, @now)
        ON CONFLICT(runtime_id) DO UPDATE SET
          room_id = excluded.room_id,
          topic = COALESCE(excluded.topic, room_bindings.topic),
          source = excluded.source,
          updated_at = excluded.updated_at
      `
      )
      .run({ runtimeId, roomId, topic, source, now });
  }

  private mergeRoomData(sourceRoomId: string, targetRoomId: string): void {
    if (sourceRoomId === targetRoomId || !this.getRoomById(sourceRoomId)) return;

    this.db
      .prepare(
        `
        INSERT OR IGNORE INTO room_members (room_id, user_id, role, created_at, updated_at)
        SELECT @targetRoomId, user_id, role, created_at, updated_at
        FROM room_members
        WHERE room_id = @sourceRoomId
      `
      )
      .run({ sourceRoomId, targetRoomId });
    this.db.prepare('DELETE FROM room_members WHERE room_id = ?').run(sourceRoomId);

    for (const tableName of roomScopedTables) {
      this.db
        .prepare(`UPDATE ${tableName} SET room_id = @targetRoomId WHERE room_id = @sourceRoomId`)
        .run({ sourceRoomId, targetRoomId });
    }

    this.db
      .prepare(
        `
        UPDATE room_bindings
        SET room_id = @targetRoomId, updated_at = @now
        WHERE room_id = @sourceRoomId
      `
      )
      .run({ sourceRoomId, targetRoomId, now: nowIso() });

    this.db
      .prepare('UPDATE rooms SET authorized = 0, enabled = 0, updated_at = ? WHERE id = ?')
      .run(nowIso(), sourceRoomId);
  }

  setRoomEnabled(roomId: string, enabled: boolean): void {
    this.db
      .prepare('UPDATE rooms SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, nowIso(), roomId);
  }

  upsertUser(userId: string, displayName?: string, role: UserRole = 'member'): void {
    const now = nowIso();
    this.db
      .prepare(
        `
        INSERT INTO users (id, display_name, role, created_at, updated_at)
        VALUES (@id, @displayName, @role, @now, @now)
        ON CONFLICT(id) DO UPDATE SET
          display_name = COALESCE(excluded.display_name, users.display_name),
          role = CASE
            WHEN users.role = 'system_admin' THEN users.role
            WHEN excluded.role = 'system_admin' THEN excluded.role
            ELSE users.role
          END,
          updated_at = excluded.updated_at
      `
      )
      .run({ id: userId, displayName, role, now });
  }

  setRoomMemberRole(roomId: string, userId: string, role: UserRole): void {
    const now = nowIso();
    this.db
      .prepare(
        `
        INSERT INTO room_members (room_id, user_id, role, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(room_id, user_id) DO UPDATE SET
          role = excluded.role,
          updated_at = excluded.updated_at
      `
      )
      .run(roomId, userId, role, now, now);
  }

  getUserRole(roomId: string, userId: string): UserRole {
    const user = this.db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as
      | { role: UserRole }
      | undefined;
    if (user?.role === 'system_admin') return 'system_admin';

    const member = this.db
      .prepare('SELECT role FROM room_members WHERE room_id = ? AND user_id = ?')
      .get(roomId, userId) as { role: UserRole } | undefined;
    if (member?.role === 'group_admin') return 'group_admin';
    return 'member';
  }

  getUserDisplayName(userId: string): string | undefined {
    const row = this.db.prepare('SELECT display_name FROM users WHERE id = ?').get(userId) as
      | { display_name?: string | null }
      | undefined;
    return row?.display_name ?? undefined;
  }

  getRoomAdmins(roomId: string): string[] {
    const rows = this.db
      .prepare("SELECT user_id FROM room_members WHERE room_id = ? AND role = 'group_admin'")
      .all(roomId) as Array<{ user_id: string }>;
    return rows.map((row) => row.user_id);
  }

  insertMessage(input: {
    id: string;
    roomId: string;
    userId: string;
    text: string;
    mentioned: boolean;
    createdAt?: string;
  }): void {
    this.db
      .prepare(
        `
        INSERT OR IGNORE INTO messages (id, room_id, user_id, text, mentioned, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        input.id,
        input.roomId,
        input.userId,
        input.text,
        input.mentioned ? 1 : 0,
        input.createdAt ?? nowIso()
      );
  }

  addAttachment(record: AttachmentRecord): void {
    this.db
      .prepare(
        `
        INSERT INTO attachments (
          id, room_id, user_id, message_id, file_name, file_path, mime_type, size_bytes,
          hash, kind, created_at, expires_at
        )
        VALUES (
          @id, @roomId, @userId, @messageId, @fileName, @filePath, @mimeType, @sizeBytes,
          @hash, @kind, @createdAt, @expiresAt
        )
      `
      )
      .run(record);
  }

  linkTaskAttachments(taskId: string, attachments: AttachmentRecord[]): void {
    if (attachments.length === 0) return;
    const now = nowIso();
    const insert = this.db.prepare(
      `
        INSERT OR IGNORE INTO task_attachments (task_id, attachment_id, created_at)
        VALUES (?, ?, ?)
      `
    );
    const tx = this.db.transaction(() => {
      for (const attachment of attachments) {
        insert.run(taskId, attachment.id, now);
      }
    });
    tx();
  }

  listTaskAttachments(taskId: string): AttachmentRecord[] {
    const rows = this.db
      .prepare(
        `
        SELECT attachments.* FROM attachments
        JOIN task_attachments ON task_attachments.attachment_id = attachments.id
        WHERE task_attachments.task_id = ?
          AND attachments.expires_at > ?
        ORDER BY task_attachments.created_at, attachments.created_at
      `
      )
      .all(taskId, nowIso()) as DbAttachment[];
    return rows.map(normalizeAttachment);
  }

  getRecentAttachment(
    roomId: string,
    userId: string,
    kind?: AttachmentKind
  ): AttachmentRecord | undefined {
    const whereKind = kind ? 'AND kind = @kind' : '';
    const row = this.db
      .prepare(
        `
        SELECT * FROM attachments
        WHERE room_id = @roomId
          AND user_id = @userId
          AND expires_at > @now
          ${whereKind}
        ORDER BY created_at DESC
        LIMIT 1
      `
      )
      .get({ roomId, userId, kind, now: nowIso() }) as DbAttachment | undefined;
    return row ? normalizeAttachment(row) : undefined;
  }

  cleanupExpiredAttachments(): number {
    const result = this.db.prepare('DELETE FROM attachments WHERE expires_at <= ?').run(nowIso());
    return result.changes;
  }

  createTask(input: {
    roomId: string;
    userId: string;
    requestType: RequestKind;
    prompt: string;
    status?: TaskStatus;
    toolName?: string;
    toolInputJson?: string;
  }): TaskRecord {
    const now = nowIso();
    const id = `task_${randomUUID().slice(0, 8)}`;
    this.db
      .prepare(
        `
        INSERT INTO tasks (
          id, room_id, user_id, request_type, status, prompt, tool_name, tool_input_json,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        id,
        input.roomId,
        input.userId,
        input.requestType,
        input.status ?? 'received',
        input.prompt,
        input.toolName,
        input.toolInputJson,
        now,
        now
      );
    return this.getTask(id)!;
  }

  getTask(taskId: string): TaskRecord | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as
      | DbTask
      | undefined;
    return row ? normalizeTask(row) : undefined;
  }

  updateTask(
    taskId: string,
    patch: {
      status?: TaskStatus;
      resultKind?: ResultKind;
      resultText?: string;
      resultPath?: string;
      error?: string;
    }
  ): TaskRecord | undefined {
    const current = this.getTask(taskId);
    if (!current) return undefined;

    this.db
      .prepare(
        `
        UPDATE tasks
        SET status = @status,
            result_kind = @resultKind,
            result_text = @resultText,
            result_path = @resultPath,
            error = @error,
            updated_at = @updatedAt
        WHERE id = @id
      `
      )
      .run({
        id: taskId,
        status: patch.status ?? current.status,
        resultKind: patch.resultKind ?? current.resultKind,
        resultText: patch.resultText ?? current.resultText,
        resultPath: patch.resultPath ?? current.resultPath,
        error: patch.error ?? current.error,
        updatedAt: nowIso()
      });

    return this.getTask(taskId);
  }

  listRoomTasks(roomId: string, limit = 5): TaskRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks WHERE room_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(roomId, limit) as DbTask[];
    return rows.map(normalizeTask);
  }

  listRecentCompletedTextTasks(
    roomId: string,
    userId: string,
    excludeTaskId: string,
    limit = 5
  ): TaskRecord[] {
    const rows = this.db
      .prepare(
        `
        SELECT * FROM tasks
        WHERE room_id = ?
          AND user_id = ?
          AND id <> ?
          AND status = 'completed'
          AND result_kind = 'text'
          AND result_text IS NOT NULL
          AND trim(result_text) <> ''
        ORDER BY created_at DESC
        LIMIT ?
      `
      )
      .all(roomId, userId, excludeTaskId, limit) as DbTask[];
    return rows.map(normalizeTask);
  }

  listRecentCompletedRoomTextTasks(roomId: string, excludeTaskId: string, limit = 8): TaskRecord[] {
    const rows = this.db
      .prepare(
        `
        SELECT * FROM tasks
        WHERE room_id = ?
          AND id <> ?
          AND status = 'completed'
          AND result_kind = 'text'
          AND result_text IS NOT NULL
          AND trim(result_text) <> ''
        ORDER BY created_at DESC
        LIMIT ?
      `
      )
      .all(roomId, excludeTaskId, limit) as DbTask[];
    return rows.map(normalizeTask);
  }

  createApproval(input: {
    taskId: string;
    roomId: string;
    requesterId: string;
    riskType: string;
    reason?: string;
    toolName?: string;
    toolInputJson?: string;
    policyReason?: string;
  }): void {
    const now = nowIso();
    this.db
      .prepare(
        `
        INSERT INTO approvals (
          id, task_id, room_id, requester_id, risk_type, status, reason,
          tool_name, tool_input_json, policy_reason, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM approvals WHERE task_id = ? AND status = 'pending'
        )
      `
      )
      .run(
        `approval_${randomUUID().slice(0, 8)}`,
        input.taskId,
        input.roomId,
        input.requesterId,
        input.riskType,
        input.reason,
        input.toolName,
        input.toolInputJson,
        input.policyReason,
        now,
        now,
        input.taskId
      );
  }

  createToolCall(input: {
    taskId: string;
    roomId: string;
    userId: string;
    toolName: string;
    riskLevel: ToolRiskLevel;
    inputJson: string;
  }): ToolCallRecord {
    const now = nowIso();
    const id = `tool_${randomUUID().slice(0, 12)}`;
    this.db
      .prepare(
        `
        INSERT INTO tool_calls (
          id, task_id, room_id, user_id, tool_name, status, risk_level, input_json,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, 'created', ?, ?, ?, ?)
      `
      )
      .run(
        id,
        input.taskId,
        input.roomId,
        input.userId,
        input.toolName,
        input.riskLevel,
        input.inputJson,
        now,
        now
      );
    return this.getToolCall(id)!;
  }

  getToolCall(toolCallId: string): ToolCallRecord | undefined {
    const row = this.db.prepare('SELECT * FROM tool_calls WHERE id = ?').get(toolCallId) as
      | DbToolCall
      | undefined;
    return row ? normalizeToolCall(row) : undefined;
  }

  updateToolCall(
    toolCallId: string,
    patch: {
      status?: ToolCallStatus;
      resultKind?: ToolResultKind;
      resultPreview?: string;
      error?: string;
      startedAt?: string;
      completedAt?: string;
    }
  ): ToolCallRecord | undefined {
    const current = this.getToolCall(toolCallId);
    if (!current) return undefined;
    this.db
      .prepare(
        `
        UPDATE tool_calls
        SET status = @status,
            result_kind = @resultKind,
            result_preview = @resultPreview,
            error = @error,
            started_at = @startedAt,
            completed_at = @completedAt,
            updated_at = @updatedAt
        WHERE id = @id
      `
      )
      .run({
        id: toolCallId,
        status: patch.status ?? current.status,
        resultKind: patch.resultKind ?? current.resultKind,
        resultPreview: patch.resultPreview ?? current.resultPreview,
        error: patch.error ?? current.error,
        startedAt: patch.startedAt ?? current.startedAt,
        completedAt: patch.completedAt ?? current.completedAt,
        updatedAt: nowIso()
      });
    return this.getToolCall(toolCallId);
  }

  listTaskToolCalls(taskId: string): ToolCallRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM tool_calls WHERE task_id = ? ORDER BY created_at')
      .all(taskId) as DbToolCall[];
    return rows.map(normalizeToolCall);
  }

  createMcpContext(input: {
    taskId: string;
    roomId: string;
    userId: string;
    role: UserRole;
    attachmentIds: string[];
    ttlMs: number;
  }): { token: string; record: McpContextRecord } {
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashCapabilityToken(token);
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + input.ttlMs).toISOString();
    this.db
      .prepare(
        `
        INSERT INTO mcp_contexts (
          token_hash, task_id, room_id, user_id, role, attachment_ids_json,
          expires_at, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          token_hash = excluded.token_hash,
          room_id = excluded.room_id,
          user_id = excluded.user_id,
          role = excluded.role,
          attachment_ids_json = excluded.attachment_ids_json,
          expires_at = excluded.expires_at,
          revoked_at = NULL,
          created_at = excluded.created_at
      `
      )
      .run(
        tokenHash,
        input.taskId,
        input.roomId,
        input.userId,
        input.role,
        JSON.stringify([...new Set(input.attachmentIds)]),
        expiresAt,
        createdAt
      );
    return { token, record: this.getMcpContextByHash(tokenHash)! };
  }

  resolveMcpContext(token: string): McpContextRecord | undefined {
    if (!token || token.length > 128) return undefined;
    const record = this.getMcpContextByHash(hashCapabilityToken(token));
    if (!record || record.revokedAt || record.expiresAt <= nowIso()) return undefined;
    return record;
  }

  revokeMcpContext(taskId: string): void {
    this.db
      .prepare('UPDATE mcp_contexts SET revoked_at = ? WHERE task_id = ? AND revoked_at IS NULL')
      .run(nowIso(), taskId);
  }

  cleanupExpiredMcpContexts(): number {
    const result = this.db
      .prepare('DELETE FROM mcp_contexts WHERE expires_at <= ? OR revoked_at IS NOT NULL')
      .run(nowIso());
    return result.changes;
  }

  private getMcpContextByHash(tokenHash: string): McpContextRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM mcp_contexts WHERE token_hash = ?')
      .get(tokenHash) as DbMcpContext | undefined;
    return row ? normalizeMcpContext(row) : undefined;
  }

  upsertHermesRun(input: {
    taskId: string;
    runId: string;
    sessionId: string;
    sessionKeyHash: string;
    contextIdHash: string;
    status: HermesRunStatus;
  }): HermesRunRecord {
    const now = nowIso();
    this.db
      .prepare(
        `
        INSERT INTO hermes_runs (
          task_id, run_id, session_id, session_key_hash, context_id_hash,
          status, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          run_id = excluded.run_id,
          session_id = excluded.session_id,
          session_key_hash = excluded.session_key_hash,
          context_id_hash = excluded.context_id_hash,
          status = excluded.status,
          error = NULL,
          updated_at = excluded.updated_at
      `
      )
      .run(
        input.taskId,
        input.runId,
        input.sessionId,
        input.sessionKeyHash,
        input.contextIdHash,
        input.status,
        now,
        now
      );
    return this.getHermesRunByTask(input.taskId)!;
  }

  getHermesRunByTask(taskId: string): HermesRunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM hermes_runs WHERE task_id = ?').get(taskId) as
      | DbHermesRun
      | undefined;
    return row ? normalizeHermesRun(row) : undefined;
  }

  updateHermesRun(
    taskId: string,
    patch: { status: HermesRunStatus; error?: string }
  ): HermesRunRecord | undefined {
    this.db
      .prepare('UPDATE hermes_runs SET status = ?, error = ?, updated_at = ? WHERE task_id = ?')
      .run(patch.status, patch.error, nowIso(), taskId);
    return this.getHermesRunByTask(taskId);
  }

  addArtifact(input: {
    taskId: string;
    runId?: string;
    kind: ArtifactKind;
    filePath: string;
    displayName: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    ttlMs: number;
  }): ArtifactRecord {
    if (input.runId) {
      const existing = this.db
        .prepare('SELECT * FROM artifacts WHERE run_id = ? AND sha256 = ?')
        .get(input.runId, input.sha256) as DbArtifact | undefined;
      if (existing) return normalizeArtifact(existing);
    }
    const id = `artifact_${randomUUID().slice(0, 12)}`;
    const createdAt = nowIso();
    this.db
      .prepare(
        `
        INSERT INTO artifacts (
          id, task_id, run_id, kind, file_path, display_name, mime_type,
          size_bytes, sha256, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        id,
        input.taskId,
        input.runId,
        input.kind,
        input.filePath,
        input.displayName,
        input.mimeType,
        input.sizeBytes,
        input.sha256,
        createdAt,
        new Date(Date.now() + input.ttlMs).toISOString()
      );
    return this.getArtifact(id)!;
  }

  getArtifact(artifactId: string): ArtifactRecord | undefined {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(artifactId) as
      | DbArtifact
      | undefined;
    return row ? normalizeArtifact(row) : undefined;
  }

  listTaskArtifacts(taskId: string): ArtifactRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM artifacts WHERE task_id = ? AND expires_at > ? ORDER BY created_at')
      .all(taskId, nowIso()) as DbArtifact[];
    return rows.map(normalizeArtifact);
  }

  markArtifactDelivered(artifactId: string): void {
    this.db.prepare('UPDATE artifacts SET delivered_at = ? WHERE id = ?').run(nowIso(), artifactId);
  }

  listRecentRoomMessages(
    roomId: string,
    limit: number
  ): Array<{ userId: string; text: string; mentioned: boolean; createdAt: string }> {
    const rows = this.db
      .prepare(
        `
        SELECT user_id, text, mentioned, created_at FROM messages
        WHERE room_id = ? AND trim(COALESCE(text, '')) <> ''
        ORDER BY created_at DESC LIMIT ?
      `
      )
      .all(roomId, limit) as Array<{
      user_id: string;
      text: string;
      mentioned: 0 | 1;
      created_at: string;
    }>;
    return rows.reverse().map((row) => ({
      userId: row.user_id,
      text: row.text,
      mentioned: row.mentioned === 1,
      createdAt: row.created_at
    }));
  }

  resolveApproval(taskId: string, approverId: string, approved: boolean): void {
    this.db
      .prepare(
        `
        UPDATE approvals
        SET status = ?, approver_id = ?, updated_at = ?
        WHERE task_id = ? AND status = 'pending'
      `
      )
      .run(approved ? 'approved' : 'rejected', approverId, nowIso(), taskId);
  }

  hasApprovedApproval(taskId: string, toolName?: string): boolean {
    const row = this.db
      .prepare(
        `
        SELECT 1 AS approved
        FROM approvals
        WHERE task_id = ?
          AND status = 'approved'
          AND (? IS NULL OR tool_name = ?)
        LIMIT 1
      `
      )
      .get(taskId, toolName ?? null, toolName ?? null) as { approved: number } | undefined;
    return Boolean(row?.approved);
  }

  createAutomation(input: {
    roomId: string;
    creatorId: string;
    name: string;
    kind: AutomationKind;
    requestType: RequestKind;
    scheduleType: AutomationScheduleType;
    scheduleSpecJson: string;
    timezone: string;
    prompt: string;
    toolName?: string;
    toolInputJson?: string;
    nextRunAt?: string;
  }): AutomationRecord {
    const now = nowIso();
    const id = `auto_${randomUUID().slice(0, 8)}`;
    this.db
      .prepare(
        `
        INSERT INTO automations (
          id, room_id, creator_id, name, kind, request_type, schedule_type, schedule_spec_json,
          timezone, prompt, tool_name, tool_input_json, status, consecutive_failures,
          next_run_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?)
      `
      )
      .run(
        id,
        input.roomId,
        input.creatorId,
        input.name,
        input.kind,
        input.requestType,
        input.scheduleType,
        input.scheduleSpecJson,
        input.timezone,
        input.prompt,
        input.toolName,
        input.toolInputJson,
        input.nextRunAt,
        now,
        now
      );
    return this.getAutomation(id)!;
  }

  getAutomation(automationId: string): AutomationRecord | undefined {
    const row = this.db.prepare('SELECT * FROM automations WHERE id = ?').get(automationId) as
      | DbAutomation
      | undefined;
    return row ? normalizeAutomation(row) : undefined;
  }

  listRoomAutomations(roomId: string, limit = 20): AutomationRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM automations WHERE room_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(roomId, limit) as DbAutomation[];
    return rows.map(normalizeAutomation);
  }

  listDueAutomations(now = nowIso()): AutomationRecord[] {
    const rows = this.db
      .prepare(
        `
        SELECT * FROM automations
        WHERE status = 'active'
          AND next_run_at IS NOT NULL
          AND next_run_at <= ?
        ORDER BY next_run_at ASC
      `
      )
      .all(now) as DbAutomation[];
    return rows.map(normalizeAutomation);
  }

  updateAutomation(
    automationId: string,
    patch: {
      status?: AutomationStatus;
      consecutiveFailures?: number;
      lastRunAt?: string;
      nextRunAt?: string | null;
      lastError?: string | null;
    }
  ): AutomationRecord | undefined {
    const current = this.getAutomation(automationId);
    if (!current) return undefined;
    this.db
      .prepare(
        `
        UPDATE automations
        SET status = @status,
            consecutive_failures = @consecutiveFailures,
            last_run_at = @lastRunAt,
            next_run_at = @nextRunAt,
            last_error = @lastError,
            updated_at = @updatedAt
        WHERE id = @id
      `
      )
      .run({
        id: automationId,
        status: patch.status ?? current.status,
        consecutiveFailures: patch.consecutiveFailures ?? current.consecutiveFailures,
        lastRunAt: patch.lastRunAt ?? current.lastRunAt,
        nextRunAt: patch.nextRunAt === undefined ? current.nextRunAt : patch.nextRunAt,
        lastError: patch.lastError === undefined ? current.lastError : patch.lastError,
        updatedAt: nowIso()
      });
    return this.getAutomation(automationId);
  }

  deleteAutomation(automationId: string): boolean {
    const result = this.db.prepare('DELETE FROM automations WHERE id = ?').run(automationId);
    return result.changes > 0;
  }

  appendContext(input: {
    scope: 'user' | 'room';
    roomId: string;
    userId?: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
  }): void {
    this.db
      .prepare(
        `
        INSERT INTO contexts (id, scope, room_id, user_id, role, content, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        `ctx_${randomUUID()}`,
        input.scope,
        input.roomId,
        input.scope === 'user' ? input.userId : null,
        input.role,
        input.content,
        nowIso()
      );
  }

  getContext(input: {
    scope: 'user' | 'room';
    roomId: string;
    userId?: string;
    limit: number;
  }): Array<{ role: 'user' | 'assistant' | 'system'; content: string }> {
    const userPredicate = input.scope === 'user' ? 'AND user_id = @userId' : 'AND user_id IS NULL';
    const rows = this.db
      .prepare(
        `
        SELECT role, content FROM contexts
        WHERE scope = @scope AND room_id = @roomId ${userPredicate}
        ORDER BY created_at DESC
        LIMIT @limit
      `
      )
      .all(input) as Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
    return rows.reverse();
  }

  getContextCount(input: { scope: 'user' | 'room'; roomId: string; userId?: string }): number {
    const userPredicate = input.scope === 'user' ? 'AND user_id = @userId' : 'AND user_id IS NULL';
    const row = this.db
      .prepare(
        `
        SELECT COUNT(*) AS count FROM contexts
        WHERE scope = @scope AND room_id = @roomId ${userPredicate}
      `
      )
      .get(input) as { count: number };
    return row.count;
  }

  listUserContextStats(): Array<{
    roomId: string;
    userId: string;
    count: number;
    lastCreatedAt: string;
  }> {
    return this.db
      .prepare(
        `
        SELECT room_id AS roomId, user_id AS userId, COUNT(*) AS count, MAX(created_at) AS lastCreatedAt
        FROM contexts
        WHERE scope = 'user' AND user_id IS NOT NULL
        GROUP BY room_id, user_id
      `
      )
      .all() as Array<{ roomId: string; userId: string; count: number; lastCreatedAt: string }>;
  }

  trimContext(input: {
    scope: 'user' | 'room';
    roomId: string;
    userId?: string;
    keep: number;
  }): number {
    if (input.keep <= 0) return this.clearContext(input);

    const userPredicate = input.scope === 'user' ? 'AND user_id = @userId' : 'AND user_id IS NULL';
    const result = this.db
      .prepare(
        `
        DELETE FROM contexts
        WHERE scope = @scope AND room_id = @roomId ${userPredicate}
          AND rowid NOT IN (
            SELECT rowid FROM contexts
            WHERE scope = @scope AND room_id = @roomId ${userPredicate}
            ORDER BY created_at DESC
            LIMIT @keep
          )
      `
      )
      .run(input);
    return result.changes;
  }

  clearContext(input: { scope: 'user' | 'room'; roomId: string; userId?: string }): number {
    const userPredicate = input.scope === 'user' ? 'AND user_id = @userId' : 'AND user_id IS NULL';
    const result = this.db
      .prepare(`DELETE FROM contexts WHERE scope = @scope AND room_id = @roomId ${userPredicate}`)
      .run(input);
    return result.changes;
  }

  addMemory(input: {
    scope: MemoryScope;
    roomId: string;
    userId?: string;
    source?: string;
    content: string;
  }): MemoryRecord {
    const now = nowIso();
    const id = `mem_${randomUUID().slice(0, 12)}`;
    this.db
      .prepare(
        `
        INSERT INTO memories (id, scope, room_id, user_id, source, content, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        id,
        input.scope,
        memoryRoomId(input.scope, input.roomId),
        input.scope === 'user' ? input.userId : null,
        input.source ?? 'manual',
        input.content.trim(),
        now,
        now
      );
    return this.getMemoryById(id)!;
  }

  upsertMemory(input: {
    scope: MemoryScope;
    roomId: string;
    userId?: string;
    source: string;
    content: string;
  }): MemoryRecord {
    const existing = this.getMemoryBySource(input);
    if (!existing) return this.addMemory(input);

    this.db
      .prepare('UPDATE memories SET content = ?, updated_at = ? WHERE id = ?')
      .run(input.content.trim(), nowIso(), existing.id);
    return this.getMemoryById(existing.id)!;
  }

  getMemoryById(memoryId: string): MemoryRecord | undefined {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(memoryId) as
      | DbMemory
      | undefined;
    return row ? normalizeMemory(row) : undefined;
  }

  getMemoryBySource(input: {
    scope: MemoryScope;
    roomId: string;
    userId?: string;
    source: string;
  }): MemoryRecord | undefined {
    const userPredicate = input.scope === 'user' ? 'AND user_id = @userId' : 'AND user_id IS NULL';
    const row = this.db
      .prepare(
        `
        SELECT * FROM memories
        WHERE scope = @scope AND room_id = @roomId ${userPredicate} AND source = @source
        ORDER BY updated_at DESC
        LIMIT 1
      `
      )
      .get({
        scope: input.scope,
        roomId: memoryRoomId(input.scope, input.roomId),
        userId: input.userId,
        source: input.source
      }) as DbMemory | undefined;
    return row ? normalizeMemory(row) : undefined;
  }

  listMemories(input: {
    scope: MemoryScope;
    roomId: string;
    userId?: string;
    limit: number;
  }): MemoryRecord[] {
    const userPredicate = input.scope === 'user' ? 'AND user_id = @userId' : 'AND user_id IS NULL';
    const rows = this.db
      .prepare(
        `
        SELECT * FROM memories
        WHERE scope = @scope AND room_id = @roomId ${userPredicate}
        ORDER BY updated_at DESC
        LIMIT @limit
      `
      )
      .all({
        scope: input.scope,
        roomId: memoryRoomId(input.scope, input.roomId),
        userId: input.userId,
        limit: input.limit
      }) as DbMemory[];
    return rows.map(normalizeMemory).reverse();
  }

  clearMemories(input: { scope: MemoryScope; roomId: string; userId?: string }): number {
    const userPredicate = input.scope === 'user' ? 'AND user_id = @userId' : 'AND user_id IS NULL';
    const result = this.db
      .prepare(`DELETE FROM memories WHERE scope = @scope AND room_id = @roomId ${userPredicate}`)
      .run({
        scope: input.scope,
        roomId: memoryRoomId(input.scope, input.roomId),
        userId: input.userId
      });
    return result.changes;
  }

  addAudit(input: { roomId?: string; userId?: string; action: string; details?: unknown }): void {
    this.db
      .prepare(
        `
        INSERT INTO audit_logs (id, room_id, user_id, action, details, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        `audit_${randomUUID()}`,
        input.roomId,
        input.userId,
        input.action,
        input.details ? JSON.stringify(input.details) : undefined,
        nowIso()
      );
  }

  listAuthorizedRooms(): RoomState[] {
    const rows = this.db
      .prepare('SELECT * FROM rooms WHERE authorized = 1 ORDER BY topic')
      .all() as DbRoom[];
    return rows.map((row) => normalizeRoom(row, this.getRoomAdmins(row.id)));
  }

  private ensureColumn(tableName: string, columnName: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
      name: string;
    }>;
    if (columns.some((column) => column.name === columnName)) return;
    this.db.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`).run();
  }
}

interface DbRoom {
  id: string;
  topic?: string;
  enabled: 0 | 1;
  authorized: 0 | 1;
}

const roomScopedTables = [
  'messages',
  'attachments',
  'tasks',
  'approvals',
  'tool_calls',
  'automations',
  'contexts',
  'memories',
  'mcp_contexts',
  'audit_logs'
] as const;

interface DbHermesRun {
  task_id: string;
  run_id: string;
  session_id: string;
  session_key_hash: string;
  context_id_hash: string;
  status: HermesRunStatus;
  error?: string | null;
  created_at: string;
  updated_at: string;
}

interface DbMcpContext {
  token_hash: string;
  task_id: string;
  room_id: string;
  user_id: string;
  role: UserRole;
  attachment_ids_json: string;
  expires_at: string;
  revoked_at?: string | null;
  created_at: string;
}

interface DbArtifact {
  id: string;
  task_id: string;
  run_id?: string | null;
  kind: ArtifactKind;
  file_path: string;
  display_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
  expires_at: string;
  delivered_at?: string | null;
}

interface DbTask {
  id: string;
  room_id: string;
  user_id: string;
  request_type: RequestKind;
  status: TaskStatus;
  prompt: string;
  tool_name?: string | null;
  tool_input_json?: string | null;
  result_kind?: ResultKind;
  result_text?: string;
  result_path?: string;
  error?: string;
  created_at: string;
  updated_at: string;
}

interface DbToolCall {
  id: string;
  task_id: string;
  room_id: string;
  user_id: string;
  tool_name: string;
  status: ToolCallStatus;
  risk_level: ToolRiskLevel;
  input_json: string;
  result_kind?: ToolResultKind | null;
  result_preview?: string | null;
  error?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  created_at: string;
  updated_at: string;
}

interface DbAutomation {
  id: string;
  room_id: string;
  creator_id: string;
  name: string;
  kind: AutomationKind;
  request_type: RequestKind;
  schedule_type: AutomationScheduleType;
  schedule_spec_json: string;
  timezone: string;
  prompt: string;
  tool_name?: string | null;
  tool_input_json?: string | null;
  status: AutomationStatus;
  consecutive_failures: number;
  last_run_at?: string | null;
  next_run_at?: string | null;
  last_error?: string | null;
  created_at: string;
  updated_at: string;
}

interface DbAttachment {
  id: string;
  room_id: string;
  user_id: string;
  message_id?: string;
  file_name: string;
  file_path: string;
  mime_type: string;
  size_bytes: number;
  hash: string;
  kind: AttachmentKind;
  created_at: string;
  expires_at: string;
}

interface DbMemory {
  id: string;
  scope: MemoryScope;
  room_id: string;
  user_id?: string | null;
  source: string;
  content: string;
  created_at: string;
  updated_at: string;
}

function normalizeRoom(row: DbRoom, admins: string[]): RoomState {
  return {
    id: row.id,
    topic: row.topic,
    enabled: row.enabled === 1,
    authorized: row.authorized === 1,
    admins
  };
}

function normalizeTask(row: DbTask): TaskRecord {
  return {
    id: row.id,
    roomId: row.room_id,
    userId: row.user_id,
    requestType: row.request_type,
    status: row.status,
    prompt: row.prompt,
    toolName: row.tool_name ?? undefined,
    toolInputJson: row.tool_input_json ?? undefined,
    resultKind: row.result_kind,
    resultText: row.result_text,
    resultPath: row.result_path,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeHermesRun(row: DbHermesRun): HermesRunRecord {
  return {
    taskId: row.task_id,
    runId: row.run_id,
    sessionId: row.session_id,
    sessionKeyHash: row.session_key_hash,
    contextIdHash: row.context_id_hash,
    status: row.status,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeMcpContext(row: DbMcpContext): McpContextRecord {
  let attachmentIds: string[] = [];
  try {
    const parsed = JSON.parse(row.attachment_ids_json) as unknown;
    if (Array.isArray(parsed))
      attachmentIds = parsed.filter((value): value is string => typeof value === 'string');
  } catch {
    attachmentIds = [];
  }
  return {
    tokenHash: row.token_hash,
    taskId: row.task_id,
    roomId: row.room_id,
    userId: row.user_id,
    role: row.role,
    attachmentIds,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at ?? undefined,
    createdAt: row.created_at
  };
}

function normalizeArtifact(row: DbArtifact): ArtifactRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id ?? undefined,
    kind: row.kind,
    filePath: row.file_path,
    displayName: row.display_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    deliveredAt: row.delivered_at ?? undefined
  };
}

function hashCapabilityToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function normalizeToolCall(row: DbToolCall): ToolCallRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    roomId: row.room_id,
    userId: row.user_id,
    toolName: row.tool_name,
    status: row.status,
    riskLevel: row.risk_level,
    inputJson: row.input_json,
    resultKind: row.result_kind ?? undefined,
    resultPreview: row.result_preview ?? undefined,
    error: row.error ?? undefined,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeAutomation(row: DbAutomation): AutomationRecord {
  return {
    id: row.id,
    roomId: row.room_id,
    creatorId: row.creator_id,
    name: row.name,
    kind: row.kind,
    requestType: row.request_type,
    scheduleType: row.schedule_type,
    scheduleSpecJson: row.schedule_spec_json,
    timezone: row.timezone,
    prompt: row.prompt,
    toolName: row.tool_name ?? undefined,
    toolInputJson: row.tool_input_json ?? undefined,
    status: row.status,
    consecutiveFailures: row.consecutive_failures,
    lastRunAt: row.last_run_at ?? undefined,
    nextRunAt: row.next_run_at ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeAttachment(row: DbAttachment): AttachmentRecord {
  return {
    id: row.id,
    roomId: row.room_id,
    userId: row.user_id,
    messageId: row.message_id,
    fileName: row.file_name,
    filePath: row.file_path,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    hash: row.hash,
    kind: row.kind,
    createdAt: row.created_at,
    expiresAt: row.expires_at
  };
}

function normalizeMemory(row: DbMemory): MemoryRecord {
  return {
    id: row.id,
    scope: row.scope,
    roomId: row.room_id,
    userId: row.user_id ?? undefined,
    source: row.source,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function memoryRoomId(_scope: MemoryScope, roomId: string): string {
  return roomId;
}
