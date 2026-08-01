import type { Logger } from 'pino';
import type { AppDatabase } from '../storage/database.js';
import type {
  AppConfig,
  AutomationKind,
  AutomationRecord,
  AutomationScheduleType,
  BotResponder
} from '../types.js';
import { formatPlainList } from '../core/replyStyle.js';
import { safeErrorSummary } from '../utils/redaction.js';

const maxScheduleOffsetMs = 10 * 366 * 24 * 60 * 60 * 1_000;

export type AutomationScheduleSpec =
  | { type: 'once'; at: string; label: string }
  | { type: 'daily'; hour: number; minute: number; label: string }
  | { type: 'weekly'; weekday: number; hour: number; minute: number; label: string }
  | { type: 'interval'; everyMs: number; label: string };

export interface AutomationRunner {
  handleAutomationTrigger(automation: AutomationRecord, responder: BotResponder): Promise<void>;
}

export interface AutomationResponderFactory {
  createRoomResponder(roomId: string): Promise<BotResponder | undefined>;
}

export class AutomationScheduler {
  private timer?: NodeJS.Timeout;
  private readonly running = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
    private readonly runner: AutomationRunner,
    private readonly responderFactory: AutomationResponderFactory,
    private readonly logger: Logger
  ) {}

  start(): void {
    if (!this.config.automations.enabled || this.timer) return;
    this.timer = setInterval(() => void this.runDueOnce().catch((error) => {
      this.logger.error({ error: safeErrorSummary(error) }, 'automation tick failed');
    }), this.config.automations.tickMs);
    this.timer.unref?.();
    void this.runDueOnce().catch((error) =>
      this.logger.error({ error: safeErrorSummary(error) }, 'initial automation tick failed')
    );
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async runDueOnce(now = new Date()): Promise<void> {
    if (!this.config.automations.enabled) return;
    for (const automation of this.db.listDueAutomations(now.toISOString())) {
      if (!this.running.has(automation.id)) await this.runOne(automation, now);
    }
  }

  private async runOne(automation: AutomationRecord, now: Date): Promise<void> {
    this.running.add(automation.id);
    const runAt = now.toISOString();
    let current = this.db.getAutomation(automation.id);
    if (!current || current.status !== 'active') {
      this.running.delete(automation.id);
      return;
    }

    let lastError: unknown;
    let dispatched = false;
    for (let attempt = 0; attempt <= this.config.automations.retryCount; attempt += 1) {
      if (attempt > 0) await delay(this.config.automations.retryDelayMs);
      try {
        const fresh = this.db.getAutomation(current.id);
        if (!fresh || fresh.status !== 'active') {
          this.running.delete(automation.id);
          return;
        }
        current = fresh;
        const room = this.db.getRoomById(current.roomId);
        if (!room?.authorized || !room.enabled) throw new Error('自动化所在群未授权或未启用');
        const responder = await this.responderFactory.createRoomResponder(current.roomId);
        if (!responder) throw new Error('无法找到自动化目标群');
        // Once the Agent runner is entered, messages, billable tools, or artifacts may
        // already have side effects. Never replay that full chain automatically.
        dispatched = true;
        await this.runner.handleAutomationTrigger(current, responder);
        this.db.updateAutomation(current.id, {
          status: current.scheduleType === 'once' ? 'completed' : 'active',
          consecutiveFailures: 0,
          lastRunAt: runAt,
          nextRunAt: current.scheduleType === 'once' ? null : computeNextRunForAutomation(current, now),
          lastError: null
        });
        this.running.delete(automation.id);
        return;
      } catch (error) {
        lastError = error;
        this.logger.warn(
          { error: safeErrorSummary(error), automationId: current.id, attempt },
          'automation attempt failed'
        );
        if (dispatched) break;
      }
    }

    const failures = current.consecutiveFailures + 1;
    this.db.updateAutomation(current.id, {
      status:
        failures >= this.config.automations.maxConsecutiveFailures || current.scheduleType === 'once'
          ? 'failed'
          : 'active',
      consecutiveFailures: failures,
      lastRunAt: runAt,
      nextRunAt: current.scheduleType === 'once' ? null : computeNextRunForAutomation(current, now),
      lastError: safeErrorSummary(lastError, 1_000)
    });
    this.running.delete(automation.id);
  }
}

export function validateScheduleSpec(
  scheduleType: AutomationScheduleType,
  value: unknown,
  now = new Date(),
  timezone = 'Asia/Shanghai'
): { spec: AutomationScheduleSpec; nextRunAt: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('自动化时间规则必须是对象。');
  }
  const record = value as Record<string, unknown>;
  let spec: AutomationScheduleSpec;
  if (scheduleType === 'once') {
    const at = typeof record.at === 'string' ? new Date(record.at) : undefined;
    if (!at || Number.isNaN(at.getTime()) || at.getTime() <= now.getTime()) {
      throw new Error('一次性任务 at 必须是未来的 ISO 时间。');
    }
    if (at.getTime() - now.getTime() > maxScheduleOffsetMs) throw new Error('自动化时间超过十年上限。');
    spec = { type: 'once', at: at.toISOString(), label: readLabel(record, formatDateTime(at.toISOString(), timezone)) };
  } else if (scheduleType === 'daily') {
    const hour = strictInteger(record.hour, 0, 23, 'hour');
    const minute = strictInteger(record.minute, 0, 59, 'minute');
    spec = { type: 'daily', hour, minute, label: readLabel(record, `每天 ${pad2(hour)}:${pad2(minute)}`) };
  } else if (scheduleType === 'weekly') {
    const weekday = strictInteger(record.weekday, 1, 7, 'weekday');
    const hour = strictInteger(record.hour, 0, 23, 'hour');
    const minute = strictInteger(record.minute, 0, 59, 'minute');
    spec = { type: 'weekly', weekday, hour, minute, label: readLabel(record, `每周${weekdayLabel(weekday)} ${pad2(hour)}:${pad2(minute)}`) };
  } else {
    const everyMs = strictInteger(record.everyMs, 60_000, maxScheduleOffsetMs, 'everyMs');
    spec = { type: 'interval', everyMs, label: readLabel(record, `每 ${formatDuration(everyMs)}`) };
  }
  return { spec, nextRunAt: computeNextRun(scheduleType, spec, now, timezone) };
}

export function computeNextRunForAutomation(automation: AutomationRecord, from = new Date()): string {
  return computeNextRun(automation.scheduleType, parseScheduleSpec(automation.scheduleSpecJson), from, automation.timezone);
}

export function parseScheduleSpec(scheduleSpecJson: string): AutomationScheduleSpec {
  const parsed = JSON.parse(scheduleSpecJson) as AutomationScheduleSpec;
  if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) throw new Error('自动化时间规则无效');
  return parsed;
}

export function formatAutomationList(automations: AutomationRecord[]): string {
  return formatPlainList(
    '小当的小闹钟',
    automations.map((automation) => {
      const spec = parseScheduleSpec(automation.scheduleSpecJson);
      return `${statusLabel(automation.status)} ${kindLabel(automation.kind)}，${spec.label}，${automation.prompt}。下次蹲点：${formatAutomationRunAt(automation.nextRunAt, automation.timezone)}`;
    }),
    '小当的小闹钟还是空的，尾巴先收好。'
  );
}

export function formatAutomationRunAt(iso: string | null | undefined, timezone: string): string {
  return iso ? formatDateTime(iso, timezone) : '无';
}

export function serializeScheduleSpec(spec: AutomationScheduleSpec): string {
  return JSON.stringify(spec);
}

function computeNextRun(
  scheduleType: AutomationScheduleType,
  spec: AutomationScheduleSpec,
  from: Date,
  timezone: string
): string {
  if (scheduleType === 'once') {
    if (spec.type !== 'once') throw new Error('一次性自动化规则无效');
    return spec.at;
  }
  if (scheduleType === 'interval') {
    if (spec.type !== 'interval') throw new Error('间隔自动化规则无效');
    return new Date(from.getTime() + spec.everyMs).toISOString();
  }
  const parts = zonedParts(from, timezone);
  if (scheduleType === 'daily') {
    if (spec.type !== 'daily') throw new Error('每日自动化规则无效');
    let candidate = makeZonedDate(parts.year, parts.month, parts.day, spec.hour, spec.minute, timezone);
    if (candidate.getTime() <= from.getTime()) {
      const next = addUtcDays(parts.year, parts.month, parts.day, 1);
      candidate = makeZonedDate(next.year, next.month, next.day, spec.hour, spec.minute, timezone);
    }
    return candidate.toISOString();
  }
  if (spec.type !== 'weekly') throw new Error('每周自动化规则无效');
  let addDays = (spec.weekday - parts.weekday + 7) % 7;
  let target = addUtcDays(parts.year, parts.month, parts.day, addDays);
  let candidate = makeZonedDate(target.year, target.month, target.day, spec.hour, spec.minute, timezone);
  if (candidate.getTime() <= from.getTime()) {
    addDays += 7;
    target = addUtcDays(parts.year, parts.month, parts.day, addDays);
    candidate = makeZonedDate(target.year, target.month, target.day, spec.hour, spec.minute, timezone);
  }
  return candidate.toISOString();
}

function strictInteger(value: unknown, min: number, max: number, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} 超出允许范围。`);
  }
  return value;
}

function readLabel(record: Record<string, unknown>, fallback: string): string {
  return typeof record.label === 'string' && record.label.trim()
    ? record.label.trim().slice(0, 80)
    : fallback;
}

function formatDuration(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000} 天`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} 小时`;
  return `${ms / 60_000} 分钟`;
}

function statusLabel(status: AutomationRecord['status']): string {
  return { active: '醒着', paused: '趴着', completed: '跑完啦', failed: '摔了一跤' }[status];
}

function kindLabel(kind: AutomationKind): string {
  return { reminder: '小提醒', scheduled_prompt: '定时小爪' }[kind];
}

function weekdayLabel(weekday: number): string {
  return ['一', '二', '三', '四', '五', '六', '日'][weekday - 1] ?? String(weekday);
}

function formatDateTime(iso: string, timezone: string): string {
  const parts = zonedParts(new Date(iso), timezone);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)} ${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

function zonedParts(date: Date, timezone: string) {
  const formatter = new Intl.DateTimeFormat('zh-CN-u-ca-gregory', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });
  const entries = Object.fromEntries(formatter.formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return {
    year: Number(entries.year), month: Number(entries.month), day: Number(entries.day),
    hour: Number(entries.hour), minute: Number(entries.minute), second: Number(entries.second),
    weekday: weekdayNumber(entries.weekday ?? '')
  };
}

function makeZonedDate(year: number, month: number, day: number, hour: number, minute: number, timezone: string): Date {
  let date = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  for (let index = 0; index < 3; index += 1) {
    const actual = zonedParts(date, timezone);
    const delta = Date.UTC(year, month - 1, day, hour, minute) - Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    if (delta === 0) break;
    date = new Date(date.getTime() + delta);
  }
  return date;
}

function addUtcDays(year: number, month: number, day: number, days: number) {
  const date = new Date(Date.UTC(year, month - 1, day + days, 12));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function weekdayNumber(value: string): number {
  if (/一|Mon/i.test(value)) return 1;
  if (/二|Tue/i.test(value)) return 2;
  if (/三|Wed/i.test(value)) return 3;
  if (/四|Thu/i.test(value)) return 4;
  if (/五|Fri/i.test(value)) return 5;
  if (/六|Sat/i.test(value)) return 6;
  return 7;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
