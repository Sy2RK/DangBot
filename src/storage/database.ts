import DatabaseConstructor, { type Database } from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type {
  AppConfig,
  AttachmentRecord,
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
  McpContextRecord,
  TaskOrigin,
  HermesSessionRecord,
  MemoryProposalRecord,
  MemoryProposalScope,
  MemoryProposalStatus,
  AgentLessonRecord,
  ReflectionBatchRecord
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
        origin TEXT NOT NULL DEFAULT 'interactive',
        status TEXT NOT NULL,
        prompt TEXT NOT NULL,
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
        purpose TEXT NOT NULL DEFAULT 'interactive',
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
        schedule_type TEXT NOT NULL,
        schedule_spec_json TEXT NOT NULL,
        timezone TEXT NOT NULL,
        prompt TEXT NOT NULL,
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

      CREATE TABLE IF NOT EXISTS hermes_sessions (
        session_key_hash TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        purpose TEXT NOT NULL DEFAULT 'interactive',
        hermes_session_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(room_id, user_id, epoch, purpose)
      );

      CREATE INDEX IF NOT EXISTS idx_hermes_sessions_scope
        ON hermes_sessions(room_id, user_id, epoch);

      CREATE TABLE IF NOT EXISTS hermes_session_epochs (
        room_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        epoch INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (room_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS memory_proposals (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        room_id TEXT NOT NULL,
        user_id TEXT,
        content TEXT NOT NULL,
        evidence TEXT NOT NULL,
        confidence REAL NOT NULL,
        status TEXT NOT NULL,
        proposer_task_id TEXT,
        decided_by TEXT,
        notified_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (proposer_task_id) REFERENCES tasks(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memory_proposals_scope_status
        ON memory_proposals(scope, room_id, user_id, status, created_at);

      CREATE TABLE IF NOT EXISTS agent_lessons (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        evidence TEXT NOT NULL,
        confidence REAL NOT NULL,
        approved_by TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS reflection_batches (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        trigger TEXT NOT NULL,
        task_ids_json TEXT NOT NULL,
        candidate_ids_json TEXT NOT NULL DEFAULT '[]',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        hermes_run_id TEXT,
        status TEXT NOT NULL,
        result TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_reflection_batches_scope
        ON reflection_batches(room_id, user_id, status, created_at);

      CREATE TABLE IF NOT EXISTS reflection_candidates (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        signal TEXT NOT NULL,
        evidence TEXT NOT NULL,
        created_at TEXT NOT NULL,
        consumed_at TEXT,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_reflection_candidates_due
        ON reflection_candidates(room_id, user_id, consumed_at, created_at);

      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

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
    this.ensureColumn('tasks', 'origin', "TEXT NOT NULL DEFAULT 'interactive'");
    this.ensureColumn('approvals', 'tool_name', 'TEXT');
    this.ensureColumn('approvals', 'tool_input_json', 'TEXT');
    this.ensureColumn('approvals', 'policy_reason', 'TEXT');
    this.ensureColumn('mcp_contexts', 'purpose', "TEXT NOT NULL DEFAULT 'interactive'");
    this.ensureColumn('memory_proposals', 'notified_at', 'TEXT');
    this.ensureColumn('reflection_batches', 'evidence_json', "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn('reflection_batches', 'candidate_ids_json', "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn('memories', 'source', "TEXT NOT NULL DEFAULT 'manual'");
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memories_source
        ON memories(scope, room_id, user_id, source);
    `);
    this.applyHermesV2DataMigration();
    this.db.exec(`
      INSERT OR IGNORE INTO room_bindings (
        runtime_id, room_id, topic, source, created_at, updated_at
      )
      SELECT id, id, topic, 'observed', created_at, updated_at
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
      this.upsertRoomBinding(roomId, room.id, topic ?? room.topic, 'observed');
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
    source: 'config' | 'observed' | 'topic'
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

  pruneRoomMessages(roomId: string, limit: number, maxAgeMs = 24 * 60 * 60 * 1_000): number {
    const safeLimit = Math.max(1, Math.min(limit, 1_000));
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    return this.db
      .prepare(
        `
        DELETE FROM messages
        WHERE room_id = ? AND (
          created_at <= ? OR id NOT IN (
            SELECT id FROM messages WHERE room_id = ?
            ORDER BY created_at DESC LIMIT ?
          )
        )
      `
      )
      .run(roomId, cutoff, roomId, safeLimit).changes;
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

  listRecentAttachments(roomId: string, userId: string, limit = 5): AttachmentRecord[] {
    const rows = this.db
      .prepare(
        `
        SELECT * FROM attachments
        WHERE room_id = ? AND user_id = ? AND expires_at > ?
        ORDER BY created_at DESC
        LIMIT ?
      `
      )
      .all(roomId, userId, nowIso(), Math.max(1, Math.min(limit, 5))) as DbAttachment[];
    return rows.map(normalizeAttachment);
  }

  getAttachment(attachmentId: string): AttachmentRecord | undefined {
    const row = this.db.prepare('SELECT * FROM attachments WHERE id = ? AND expires_at > ?').get(
      attachmentId,
      nowIso()
    ) as DbAttachment | undefined;
    return row ? normalizeAttachment(row) : undefined;
  }

  cleanupExpiredAttachments(): number {
    const result = this.db.prepare('DELETE FROM attachments WHERE expires_at <= ?').run(nowIso());
    return result.changes;
  }

  createTask(input: {
    roomId: string;
    userId: string;
    origin?: TaskOrigin;
    prompt: string;
    status?: TaskStatus;
  }): TaskRecord {
    const now = nowIso();
    const id = `task_${randomUUID().slice(0, 8)}`;
    this.db
      .prepare(
        `
        INSERT INTO tasks (
          id, room_id, user_id, origin, status, prompt, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        id,
        input.roomId,
        input.userId,
        input.origin ?? 'interactive',
        input.status ?? 'received',
        input.prompt,
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
    purpose?: TaskOrigin;
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
          token_hash, task_id, room_id, user_id, role, purpose, attachment_ids_json,
          expires_at, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          token_hash = excluded.token_hash,
          room_id = excluded.room_id,
          user_id = excluded.user_id,
          role = excluded.role,
          purpose = excluded.purpose,
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
        input.purpose ?? 'interactive',
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

  invalidateAllMcpContexts(): number {
    return this.db.prepare('DELETE FROM mcp_contexts').run().changes;
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

  listActiveHermesRuns(): HermesRunRecord[] {
    const rows = this.db
      .prepare(
        `
        SELECT * FROM hermes_runs
        WHERE status IN ('queued', 'running', 'waiting_for_approval', 'stopping')
        ORDER BY created_at
      `
      )
      .all() as DbHermesRun[];
    return rows.map(normalizeHermesRun);
  }

  reconcileInterruptedWork(reason: string): {
    taskCount: number;
    hermesRuns: HermesRunRecord[];
    reflectionBatchCount: number;
  } {
    const hermesRuns = this.listActiveHermesRuns();
    const reflectionBatches = this.db
      .prepare("SELECT * FROM reflection_batches WHERE status IN ('pending', 'running')")
      .all() as DbReflectionBatch[];
    const now = nowIso();
    let taskCount = 0;
    const tx = this.db.transaction(() => {
      taskCount = this.db
        .prepare(
          `
          UPDATE tasks SET status = 'failed', error = ?, updated_at = ?
          WHERE status IN ('received', 'processing', 'waiting_approval')
        `
        )
        .run(reason, now).changes;
      this.db
        .prepare(
          `
          UPDATE hermes_runs SET status = 'stopping', error = ?, updated_at = ?
          WHERE status IN ('queued', 'running', 'waiting_for_approval', 'stopping')
        `
        )
        .run(reason, now);
      for (const row of reflectionBatches) {
        const batch = normalizeReflectionBatch(row);
        this.releaseReflectionCandidates(batch);
        this.db
          .prepare(
            "UPDATE reflection_batches SET status = 'failed', result = ?, updated_at = ? WHERE id = ?"
          )
          .run(reason, now, batch.id);
      }
    });
    tx();
    return { taskCount, hermesRuns, reflectionBatchCount: reflectionBatches.length };
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
        WHERE room_id = ? AND created_at > ? AND trim(COALESCE(text, '')) <> ''
        ORDER BY created_at DESC LIMIT ?
      `
      )
      .all(roomId, new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString(), limit) as Array<{
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

  clearRoomMessages(roomId: string): number {
    return this.db.prepare('DELETE FROM messages WHERE room_id = ?').run(roomId).changes;
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
    scheduleType: AutomationScheduleType;
    scheduleSpecJson: string;
    timezone: string;
    prompt: string;
    nextRunAt?: string;
  }): AutomationRecord {
    const now = nowIso();
    const id = `auto_${randomUUID().slice(0, 8)}`;
    this.db
      .prepare(
        `
        INSERT INTO automations (
          id, room_id, creator_id, name, kind, schedule_type, schedule_spec_json,
          timezone, prompt, status, consecutive_failures,
          next_run_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?)
      `
      )
      .run(
        id,
        input.roomId,
        input.creatorId,
        input.name,
        input.kind,
        input.scheduleType,
        input.scheduleSpecJson,
        input.timezone,
        input.prompt,
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
      prompt?: string;
      scheduleType?: AutomationScheduleType;
      scheduleSpecJson?: string;
      timezone?: string;
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
        SET prompt = @prompt,
            schedule_type = @scheduleType,
            schedule_spec_json = @scheduleSpecJson,
            timezone = @timezone,
            status = @status,
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
        prompt: patch.prompt ?? current.prompt,
        scheduleType: patch.scheduleType ?? current.scheduleType,
        scheduleSpecJson: patch.scheduleSpecJson ?? current.scheduleSpecJson,
        timezone: patch.timezone ?? current.timezone,
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

  findLatestActiveTask(
    roomId: string,
    userId: string,
    purpose?: 'interactive' | 'reflection'
  ): TaskRecord | undefined {
    const purposePredicate =
      purpose === 'reflection'
        ? "AND origin = 'reflection'"
        : purpose === 'interactive'
          ? "AND origin IN ('interactive', 'automation')"
          : '';
    const row = this.db
      .prepare(
        `
        SELECT * FROM tasks
        WHERE room_id = ? AND user_id = ? AND status IN ('received', 'processing', 'waiting_approval')
          ${purposePredicate}
        ORDER BY created_at DESC LIMIT 1
      `
      )
      .get(roomId, userId) as DbTask | undefined;
    return row ? normalizeTask(row) : undefined;
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

  deleteUserMemory(memoryId: string, roomId: string, userId: string): boolean {
    const result = this.db
      .prepare(
        "DELETE FROM memories WHERE id = ? AND scope = 'user' AND room_id = ? AND user_id = ?"
      )
      .run(memoryId, roomId, userId);
    return result.changes > 0;
  }

  getSessionEpoch(roomId: string, userId: string, purpose: TaskOrigin = 'interactive'): number {
    if (purpose === 'interactive') {
      const state = this.db
        .prepare('SELECT epoch FROM hermes_session_epochs WHERE room_id = ? AND user_id = ?')
        .get(roomId, userId) as { epoch: number } | undefined;
      if (state) return state.epoch;
    }
    const row = this.db
      .prepare(
        'SELECT MAX(epoch) AS epoch FROM hermes_sessions WHERE room_id = ? AND user_id = ? AND purpose = ?'
      )
      .get(roomId, userId, purpose) as { epoch?: number | null };
    return row.epoch ?? 0;
  }

  upsertHermesSession(input: {
    sessionKeyHash: string;
    roomId: string;
    userId: string;
    epoch: number;
    purpose: TaskOrigin;
    hermesSessionId: string;
  }): HermesSessionRecord {
    const now = nowIso();
    this.db
      .prepare(
        `
        INSERT INTO hermes_sessions (
          session_key_hash, room_id, user_id, epoch, purpose, hermes_session_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(room_id, user_id, epoch, purpose) DO UPDATE SET
          session_key_hash = excluded.session_key_hash,
          hermes_session_id = excluded.hermes_session_id,
          updated_at = excluded.updated_at
      `
      )
      .run(
        input.sessionKeyHash,
        input.roomId,
        input.userId,
        input.epoch,
        input.purpose,
        input.hermesSessionId,
        now,
        now
      );
    if (input.purpose === 'interactive') {
      this.db
        .prepare(
          `
          INSERT INTO hermes_session_epochs (room_id, user_id, epoch, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(room_id, user_id) DO UPDATE SET
            epoch = MAX(hermes_session_epochs.epoch, excluded.epoch),
            updated_at = excluded.updated_at
        `
        )
        .run(input.roomId, input.userId, input.epoch, now);
    }
    return this.getHermesSessionByHash(input.sessionKeyHash)!;
  }

  getHermesSessionByHash(sessionKeyHash: string): HermesSessionRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM hermes_sessions WHERE session_key_hash = ?')
      .get(sessionKeyHash) as DbHermesSession | undefined;
    return row ? normalizeHermesSession(row) : undefined;
  }

  rotateHermesSession(roomId: string, userId: string): number {
    const nextEpoch = this.getSessionEpoch(roomId, userId, 'interactive') + 1;
    this.db
      .prepare(
        `
        INSERT INTO hermes_session_epochs (room_id, user_id, epoch, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(room_id, user_id) DO UPDATE SET
          epoch = excluded.epoch,
          updated_at = excluded.updated_at
      `
      )
      .run(roomId, userId, nextEpoch, nowIso());
    this.addAudit({ roomId, userId, action: 'hermes_session_rotated', details: { nextEpoch } });
    return nextEpoch;
  }

  addMemoryProposal(input: {
    scope: MemoryProposalScope;
    roomId: string;
    userId?: string;
    content: string;
    evidence: string;
    confidence: number;
    status?: MemoryProposalStatus;
    proposerTaskId?: string;
  }): MemoryProposalRecord {
    const now = nowIso();
    const id = `proposal_${randomUUID().slice(0, 12)}`;
    this.db
      .prepare(
        `
        INSERT INTO memory_proposals (
          id, scope, room_id, user_id, content, evidence, confidence, status,
          proposer_task_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        id,
        input.scope,
        input.roomId,
        input.userId,
        input.content.trim(),
        input.evidence.trim(),
        Math.max(0, Math.min(1, input.confidence)),
        input.status ?? 'pending',
        input.proposerTaskId,
        now,
        now
      );
    return this.getMemoryProposal(id)!;
  }

  getMemoryProposal(id: string): MemoryProposalRecord | undefined {
    const row = this.db.prepare('SELECT * FROM memory_proposals WHERE id = ?').get(id) as
      | DbMemoryProposal
      | undefined;
    return row ? normalizeMemoryProposal(row) : undefined;
  }

  listMemoryProposals(input: {
    roomId: string;
    userId?: string;
    status?: MemoryProposalStatus;
    limit?: number;
  }): MemoryProposalRecord[] {
    const rows = this.db
      .prepare(
        `
        SELECT * FROM memory_proposals
        WHERE room_id = @roomId
          AND (@userId IS NULL OR user_id = @userId)
          AND (@status IS NULL OR status = @status)
        ORDER BY created_at DESC LIMIT @limit
      `
      )
      .all({
        roomId: input.roomId,
        userId: input.userId ?? null,
        status: input.status ?? null,
        limit: Math.max(1, Math.min(input.limit ?? 20, 100))
      }) as DbMemoryProposal[];
    return rows.map(normalizeMemoryProposal);
  }

  resolveMemoryProposal(
    proposalId: string,
    approved: boolean,
    decidedBy: string
  ): MemoryProposalRecord | undefined {
    const proposal = this.getMemoryProposal(proposalId);
    if (!proposal || proposal.status !== 'pending') return proposal;
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          'UPDATE memory_proposals SET status = ?, decided_by = ?, updated_at = ? WHERE id = ?'
        )
        .run(approved ? 'approved' : 'rejected', decidedBy, nowIso(), proposalId);
      if (!approved) return;
      if (proposal.scope === 'agent') {
        this.addAgentLesson({
          content: proposal.content,
          evidence: proposal.evidence,
          confidence: proposal.confidence,
          approvedBy: decidedBy
        });
      } else {
        this.addMemory({
          scope: proposal.scope,
          roomId: proposal.roomId,
          userId: proposal.scope === 'user' ? proposal.userId : undefined,
          source: `proposal:${proposal.id}`,
          content: proposal.content
        });
      }
    });
    tx();
    return this.getMemoryProposal(proposalId);
  }

  listUnnotifiedAutoMemoryProposals(roomId: string, userId: string): MemoryProposalRecord[] {
    const rows = this.db
      .prepare(
        `
        SELECT * FROM memory_proposals
        WHERE room_id = ? AND user_id = ? AND scope = 'user'
          AND status = 'auto_approved' AND notified_at IS NULL
        ORDER BY created_at LIMIT 10
      `
      )
      .all(roomId, userId) as DbMemoryProposal[];
    return rows.map(normalizeMemoryProposal);
  }

  markMemoryProposalsNotified(ids: string[]): void {
    if (ids.length === 0) return;
    const update = this.db.prepare(
      "UPDATE memory_proposals SET notified_at = ?, updated_at = ? WHERE id = ? AND notified_at IS NULL"
    );
    const tx = this.db.transaction(() => {
      const now = nowIso();
      for (const id of ids) update.run(now, now, id);
    });
    tx();
  }

  addAgentLesson(input: {
    content: string;
    evidence: string;
    confidence: number;
    approvedBy: string;
  }): AgentLessonRecord {
    const id = `lesson_${randomUUID().slice(0, 12)}`;
    const now = nowIso();
    this.db
      .prepare(
        `
        INSERT INTO agent_lessons (
          id, content, evidence, confidence, approved_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        id,
        input.content.trim(),
        input.evidence.trim(),
        Math.max(0, Math.min(1, input.confidence)),
        input.approvedBy,
        now,
        now
      );
    return this.listAgentLessons(100).find((lesson) => lesson.id === id)!;
  }

  listAgentLessons(limit = 20): AgentLessonRecord[] {
    const rows = this.db
      .prepare(
        `
        SELECT * FROM agent_lessons WHERE revoked_at IS NULL
        ORDER BY updated_at DESC LIMIT ?
      `
      )
      .all(Math.max(1, Math.min(limit, 100))) as DbAgentLesson[];
    return rows.map(normalizeAgentLesson).reverse();
  }

  revokeAgentLesson(id: string): boolean {
    const result = this.db
      .prepare(
        'UPDATE agent_lessons SET revoked_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL'
      )
      .run(nowIso(), nowIso(), id);
    return result.changes > 0;
  }

  addReflectionCandidate(input: {
    roomId: string;
    userId: string;
    taskId: string;
    signal: string;
    evidence: string;
  }): void {
    this.db
      .prepare(
        `
        INSERT INTO reflection_candidates (
          id, room_id, user_id, task_id, signal, evidence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        `candidate_${randomUUID().slice(0, 12)}`,
        input.roomId,
        input.userId,
        input.taskId,
        input.signal,
        input.evidence.slice(0, 4_000),
        nowIso()
      );
  }

  listReflectionCandidateGroups(): Array<{
    roomId: string;
    userId: string;
    count: number;
    oldestAt: string;
  }> {
    return this.db
      .prepare(
        `
        SELECT room_id AS roomId, user_id AS userId, COUNT(*) AS count,
               MIN(created_at) AS oldestAt
        FROM reflection_candidates WHERE consumed_at IS NULL
        GROUP BY room_id, user_id
      `
      )
      .all() as Array<{ roomId: string; userId: string; count: number; oldestAt: string }>;
  }

  createReflectionBatch(input: {
    roomId: string;
    userId: string;
    trigger: 'threshold' | 'idle' | 'manual';
    maxTasks: number;
  }): ReflectionBatchRecord | undefined {
    const candidates = this.db
      .prepare(
        `
        SELECT id, task_id, signal, evidence FROM reflection_candidates
        WHERE room_id = ? AND user_id = ? AND consumed_at IS NULL
        ORDER BY created_at LIMIT ?
      `
      )
      .all(input.roomId, input.userId, Math.max(1, Math.min(input.maxTasks, 8))) as Array<{
      id: string;
      task_id: string;
      signal: string;
      evidence: string;
    }>;
    if (candidates.length === 0) return undefined;
    const id = `reflection_${randomUUID().slice(0, 12)}`;
    const now = nowIso();
    const taskIds = [...new Set(candidates.map((entry) => entry.task_id))];
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `
          INSERT INTO reflection_batches (
            id, room_id, user_id, trigger, task_ids_json, candidate_ids_json,
            evidence_json, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        `
        )
        .run(
          id,
          input.roomId,
          input.userId,
          input.trigger,
          JSON.stringify(taskIds),
          JSON.stringify(candidates.map((candidate) => candidate.id)),
          JSON.stringify(
            candidates.map((candidate) => ({
              taskId: candidate.task_id,
              signal: candidate.signal,
              evidence: candidate.evidence
            }))
          ),
          now,
          now
        );
      const mark = this.db.prepare(
        'UPDATE reflection_candidates SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL'
      );
      for (const candidate of candidates) mark.run(now, candidate.id);
    });
    tx();
    return this.getReflectionBatch(id)!;
  }

  getReflectionBatch(id: string): ReflectionBatchRecord | undefined {
    const row = this.db.prepare('SELECT * FROM reflection_batches WHERE id = ?').get(id) as
      | DbReflectionBatch
      | undefined;
    return row ? normalizeReflectionBatch(row) : undefined;
  }

  updateReflectionBatch(
    id: string,
    patch: { status: ReflectionBatchRecord['status']; hermesRunId?: string; result?: string }
  ): ReflectionBatchRecord | undefined {
    const current = this.getReflectionBatch(id);
    if (!current) return undefined;
    this.db
      .prepare(
        `
        UPDATE reflection_batches SET status = ?, hermes_run_id = ?, result = ?, updated_at = ?
        WHERE id = ?
      `
      )
      .run(
        patch.status,
        patch.hermesRunId ?? current.hermesRunId,
        patch.result ?? current.result,
        nowIso(),
        id
      );
    return this.getReflectionBatch(id);
  }

  failReflectionBatch(id: string, result: string): ReflectionBatchRecord | undefined {
    const current = this.getReflectionBatch(id);
    if (!current || current.status === 'completed') return current;
    const tx = this.db.transaction(() => {
      this.releaseReflectionCandidates(current);
      this.db
        .prepare(
          "UPDATE reflection_batches SET status = 'failed', result = ?, updated_at = ? WHERE id = ?"
        )
        .run(result, nowIso(), id);
    });
    tx();
    return this.getReflectionBatch(id);
  }

  latestReflectionAt(roomId: string, userId: string): string | undefined {
    const row = this.db
      .prepare(
        `
        SELECT MAX(created_at) AS created_at FROM reflection_batches
        WHERE room_id = ? AND user_id = ? AND status IN ('pending', 'running', 'completed')
      `
      )
      .get(roomId, userId) as { created_at?: string | null };
    return row.created_at ?? undefined;
  }

  private releaseReflectionCandidates(batch: ReflectionBatchRecord): void {
    if (batch.candidateIds.length > 0) {
      const release = this.db.prepare(
        'UPDATE reflection_candidates SET consumed_at = NULL WHERE id = ?'
      );
      for (const id of batch.candidateIds) release.run(id);
      return;
    }

    const existing = this.db.prepare(
      `
      SELECT 1 FROM reflection_candidates
      WHERE task_id = ? AND signal = ? AND evidence = ? AND consumed_at IS NULL
      LIMIT 1
    `
    );
    const insert = this.db.prepare(
      `
      INSERT INTO reflection_candidates (
        id, room_id, user_id, task_id, signal, evidence, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `
    );
    for (const candidate of batch.evidence) {
      if (existing.get(candidate.taskId, candidate.signal, candidate.evidence)) continue;
      insert.run(
        `reflection_candidate_${randomUUID().slice(0, 12)}`,
        batch.roomId,
        batch.userId,
        candidate.taskId,
        candidate.signal,
        candidate.evidence,
        nowIso()
      );
    }
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

  private hasColumn(tableName: string, columnName: string): boolean {
    const columns = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
      name: string;
    }>;
    return columns.some((column) => column.name === columnName);
  }

  private applyHermesV2DataMigration(): void {
    const applied = this.db
      .prepare('SELECT 1 AS applied FROM schema_migrations WHERE id = ?')
      .get('hermes_v2') as { applied: number } | undefined;
    if (!applied) {
      const tx = this.db.transaction(() => {
        // Only explicit user-authored memories survive the migration. The old
        // wildcard room was cross-room state and is intentionally discarded.
        this.db.prepare("DELETE FROM memories WHERE source <> 'manual' OR room_id = '*'").run();
        this.db.prepare("UPDATE memories SET scope = 'room' WHERE scope = 'global'").run();
        this.db.prepare("UPDATE automations SET kind = 'scheduled_prompt' WHERE kind = 'scheduled_tool'").run();
        this.db.prepare("UPDATE room_bindings SET source = 'observed' WHERE source = 'legacy'").run();
        this.db.prepare('DROP TABLE IF EXISTS contexts').run();
        this.db
          .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
          .run('hermes_v2', nowIso());
      });
      tx();
    }

    // SQLite supports DROP COLUMN on all supported DangBot runtimes. These
    // fields encoded the removed Node classifier/agent route and must not stay
    // available to new code as a shadow planning channel.
    for (const [table, column] of [
      ['tasks', 'request_type'],
      ['tasks', 'tool_name'],
      ['tasks', 'tool_input_json'],
      ['automations', 'request_type'],
      ['automations', 'tool_name'],
      ['automations', 'tool_input_json']
    ] as const) {
      if (this.hasColumn(table, column)) {
        this.db.prepare(`ALTER TABLE ${table} DROP COLUMN ${column}`).run();
      }
    }
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
  'memories',
  'mcp_contexts',
  'hermes_sessions',
  'hermes_session_epochs',
  'memory_proposals',
  'reflection_batches',
  'reflection_candidates',
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
  purpose: TaskOrigin;
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

interface DbHermesSession {
  session_key_hash: string;
  room_id: string;
  user_id: string;
  epoch: number;
  purpose: TaskOrigin;
  hermes_session_id: string;
  created_at: string;
  updated_at: string;
}

interface DbMemoryProposal {
  id: string;
  scope: MemoryProposalScope;
  room_id: string;
  user_id?: string | null;
  content: string;
  evidence: string;
  confidence: number;
  status: MemoryProposalStatus;
  proposer_task_id?: string | null;
  decided_by?: string | null;
  created_at: string;
  updated_at: string;
}

interface DbAgentLesson {
  id: string;
  content: string;
  evidence: string;
  confidence: number;
  approved_by: string;
  revoked_at?: string | null;
  created_at: string;
  updated_at: string;
}

interface DbReflectionBatch {
  id: string;
  room_id: string;
  user_id: string;
  trigger: ReflectionBatchRecord['trigger'];
  task_ids_json: string;
  candidate_ids_json: string;
  evidence_json: string;
  hermes_run_id?: string | null;
  status: ReflectionBatchRecord['status'];
  result?: string | null;
  created_at: string;
  updated_at: string;
}

interface DbTask {
  id: string;
  room_id: string;
  user_id: string;
  origin: TaskOrigin;
  status: TaskStatus;
  prompt: string;
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
  schedule_type: AutomationScheduleType;
  schedule_spec_json: string;
  timezone: string;
  prompt: string;
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
    origin: row.origin,
    status: row.status,
    prompt: row.prompt,
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
    purpose: row.purpose,
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

function normalizeHermesSession(row: DbHermesSession): HermesSessionRecord {
  return {
    sessionKeyHash: row.session_key_hash,
    roomId: row.room_id,
    userId: row.user_id,
    epoch: row.epoch,
    purpose: row.purpose,
    hermesSessionId: row.hermes_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeMemoryProposal(row: DbMemoryProposal): MemoryProposalRecord {
  return {
    id: row.id,
    scope: row.scope,
    roomId: row.room_id,
    userId: row.user_id ?? undefined,
    content: row.content,
    evidence: row.evidence,
    confidence: row.confidence,
    status: row.status,
    proposerTaskId: row.proposer_task_id ?? undefined,
    decidedBy: row.decided_by ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeAgentLesson(row: DbAgentLesson): AgentLessonRecord {
  return {
    id: row.id,
    content: row.content,
    evidence: row.evidence,
    confidence: row.confidence,
    approvedBy: row.approved_by,
    revokedAt: row.revoked_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeReflectionBatch(row: DbReflectionBatch): ReflectionBatchRecord {
  let taskIds: string[] = [];
  let candidateIds: string[] = [];
  let evidence: ReflectionBatchRecord['evidence'] = [];
  try {
    const parsed = JSON.parse(row.task_ids_json) as unknown;
    if (Array.isArray(parsed)) {
      taskIds = parsed.filter((value): value is string => typeof value === 'string');
    }
  } catch {
    taskIds = [];
  }
  try {
    const parsed = JSON.parse(row.candidate_ids_json) as unknown;
    if (Array.isArray(parsed)) {
      candidateIds = parsed.filter((value): value is string => typeof value === 'string');
    }
  } catch {
    candidateIds = [];
  }
  try {
    const parsed = JSON.parse(row.evidence_json) as unknown;
    if (Array.isArray(parsed)) {
      evidence = parsed.filter(
        (value): value is ReflectionBatchRecord['evidence'][number] =>
          Boolean(
            value &&
              typeof value === 'object' &&
              'taskId' in value &&
              typeof value.taskId === 'string' &&
              'signal' in value &&
              typeof value.signal === 'string' &&
              'evidence' in value &&
              typeof value.evidence === 'string'
          )
      );
    }
  } catch {
    evidence = [];
  }
  return {
    id: row.id,
    roomId: row.room_id,
    userId: row.user_id,
    trigger: row.trigger,
    taskIds,
    candidateIds,
    evidence,
    hermesRunId: row.hermes_run_id ?? undefined,
    status: row.status,
    result: row.result ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
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
    scheduleType: row.schedule_type,
    scheduleSpecJson: row.schedule_spec_json,
    timezone: row.timezone,
    prompt: row.prompt,
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
