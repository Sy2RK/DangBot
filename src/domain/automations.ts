import type { Logger } from 'pino';
import type { AppDatabase } from '../storage/database.js';
import type {
  AppConfig,
  AutomationKind,
  AutomationRecord,
  AutomationScheduleType,
  BotResponder,
  RequestKind
} from '../types.js';
import { formatPlainList } from '../core/replyStyle.js';

const maxScheduleOffsetMs = 10 * 366 * 24 * 60 * 60 * 1000;

export interface AutomationDefinition {
  name: string;
  kind: AutomationKind;
  requestType: RequestKind;
  scheduleType: AutomationScheduleType;
  scheduleSpec: AutomationScheduleSpec;
  timezone: string;
  prompt: string;
  nextRunAt: string;
}

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
    this.timer = setInterval(() => {
      void this.runDueOnce().catch((error) => {
        this.logger.error({ error }, 'automation tick failed');
      });
    }, this.config.automations.tickMs);
    this.timer.unref?.();
    void this.runDueOnce().catch((error) => {
      this.logger.error({ error }, 'initial automation tick failed');
    });
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async runDueOnce(now = new Date()): Promise<void> {
    if (!this.config.automations.enabled) return;

    const due = this.db.listDueAutomations(now.toISOString());
    for (const automation of due) {
      if (this.running.has(automation.id)) continue;
      await this.runOne(automation, now);
    }
  }

  private async runOne(automation: AutomationRecord, now: Date): Promise<void> {
    this.running.add(automation.id);
    const runAt = now.toISOString();

    try {
      const current = this.db.getAutomation(automation.id);
      if (!current || current.status !== 'active') return;

      const room = this.db.getRoomById(current.roomId);
      if (!room?.authorized || !room.enabled) {
        throw new Error('自动化所在群未授权或未启用');
      }

      const responder = await this.responderFactory.createRoomResponder(current.roomId);
      if (!responder) {
        throw new Error('无法找到自动化目标群');
      }

      await this.runner.handleAutomationTrigger(current, responder);
      this.db.updateAutomation(current.id, {
        status: current.scheduleType === 'once' ? 'completed' : 'active',
        consecutiveFailures: 0,
        lastRunAt: runAt,
        nextRunAt:
          current.scheduleType === 'once' ? null : computeNextRunForAutomation(current, now),
        lastError: null
      });
    } catch (error) {
      const current = this.db.getAutomation(automation.id) ?? automation;
      const message = error instanceof Error ? error.message : String(error);
      const failures = current.consecutiveFailures + 1;
      this.logger.error({ error, automationId: current.id }, 'automation run failed');
      this.db.updateAutomation(current.id, {
        status:
          failures >= this.config.automations.maxConsecutiveFailures || current.scheduleType === 'once'
            ? 'failed'
            : 'active',
        consecutiveFailures: failures,
        lastRunAt: runAt,
        nextRunAt:
          current.scheduleType === 'once' ? null : computeNextRunForAutomation(current, now),
        lastError: message
      });
    } finally {
      this.running.delete(automation.id);
    }
  }
}

export function parseAutomationDefinition(
  rawText: string,
  options: { now?: Date; timezone: string; defaultRequestType?: RequestKind }
): AutomationDefinition | undefined {
  const now = options.now ?? new Date();
  const timezone = options.timezone;
  const { body, requestedReminder } = stripAutomationPrefix(rawText);
  if (!body) return undefined;

  const parsed = parseSchedule(body, now, timezone);
  if (!parsed) return undefined;

  const prompt = stripActionPrefix(parsed.prompt);
  if (!prompt) return undefined;

  const kind: AutomationKind =
    requestedReminder || parsed.requestedReminder ? 'reminder' : 'scheduled_prompt';
  const requestType = kind === 'reminder' ? 'qa' : (options.defaultRequestType ?? 'qa');

  return {
    name: buildAutomationName(kind, prompt),
    kind,
    requestType,
    scheduleType: parsed.scheduleType,
    scheduleSpec: parsed.scheduleSpec,
    timezone,
    prompt,
    nextRunAt: computeNextRun(parsed.scheduleType, parsed.scheduleSpec, now, timezone)
  };
}

export function computeNextRunForAutomation(
  automation: AutomationRecord,
  from = new Date()
): string {
  return computeNextRun(
    automation.scheduleType,
    parseScheduleSpec(automation.scheduleSpecJson),
    from,
    automation.timezone
  );
}

export function parseScheduleSpec(scheduleSpecJson: string): AutomationScheduleSpec {
  const parsed = JSON.parse(scheduleSpecJson) as AutomationScheduleSpec;
  if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) {
    throw new Error('自动化时间规则无效');
  }
  return parsed;
}

export function formatAutomationList(automations: AutomationRecord[]): string {
  return formatPlainList(
    '自动化列表',
    automations.map((automation) => {
      const spec = parseScheduleSpec(automation.scheduleSpecJson);
      const next = automation.nextRunAt ? formatDateTime(automation.nextRunAt, automation.timezone) : '无';
      return `${automation.id} ${statusLabel(automation.status)} ${kindLabel(automation.kind)} ${spec.label} ${automation.prompt} 下次：${next}`;
    }),
    '自动化列表还是空的。'
  );
}

export function serializeScheduleSpec(spec: AutomationScheduleSpec): string {
  return JSON.stringify(spec);
}

function parseSchedule(
  text: string,
  now: Date,
  timezone: string
):
  | {
      scheduleType: AutomationScheduleType;
      scheduleSpec: AutomationScheduleSpec;
      prompt: string;
      requestedReminder: boolean;
    }
  | undefined {
  const normalized = text.trim();

  const intervalOnce = normalized.match(/^(\d+)\s*(分钟|分|小时|钟头|天)后\s*(.+)$/);
  if (intervalOnce?.[1] && intervalOnce[2] && intervalOnce[3]) {
    const everyMs = durationMs(Number(intervalOnce[1]), intervalOnce[2]);
    if (!everyMs) return undefined;
    const prompt = intervalOnce[3].trim();
    return {
      scheduleType: 'once',
      scheduleSpec: {
        type: 'once',
        at: new Date(now.getTime() + everyMs).toISOString(),
        label: `${intervalOnce[1]}${intervalOnce[2]}后`
      },
      prompt,
      requestedReminder: startsAsReminder(prompt)
    };
  }

  const absolute = normalized.match(
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2})[:：](\d{1,2})\s+(.+)$/
  );
  if (absolute?.[1] && absolute[2] && absolute[3] && absolute[4] && absolute[5] && absolute[6]) {
    const year = Number(absolute[1]);
    const month = Number(absolute[2]);
    const day = Number(absolute[3]);
    const hour = Number(absolute[4]);
    const minute = Number(absolute[5]);
    if (!validDate(year, month, day)) return undefined;
    if (!validClock(hour, minute)) return undefined;
    const at = makeZonedDate(year, month, day, hour, minute, timezone);
    return {
      scheduleType: 'once',
      scheduleSpec: {
        type: 'once',
        at: at.toISOString(),
        label: `${absolute[1]}-${pad2(Number(absolute[2]))}-${pad2(Number(absolute[3]))} ${pad2(hour)}:${pad2(minute)}`
      },
      prompt: absolute[6].trim(),
      requestedReminder: startsAsReminder(absolute[6])
    };
  }

  const relativeDay = normalized.match(/^(今天|明天|后天)\s*(\d{1,2})(?:[:：点](\d{1,2})?)?分?\s+(.+)$/);
  if (relativeDay?.[1] && relativeDay[2] && relativeDay[4]) {
    const parts = zonedParts(now, timezone);
    const dayOffset = relativeDay[1] === '今天' ? 0 : relativeDay[1] === '明天' ? 1 : 2;
    const targetDate = addUtcDays(parts.year, parts.month, parts.day, dayOffset);
    const hour = Number(relativeDay[2]);
    const minute = Number(relativeDay[3] ?? 0);
    if (!validClock(hour, minute)) return undefined;
    const at = makeZonedDate(
      targetDate.year,
      targetDate.month,
      targetDate.day,
      hour,
      minute,
      timezone
    );
    return {
      scheduleType: 'once',
      scheduleSpec: {
        type: 'once',
        at: at.toISOString(),
        label: `${relativeDay[1]} ${pad2(hour)}:${pad2(minute)}`
      },
      prompt: relativeDay[4].trim(),
      requestedReminder: startsAsReminder(relativeDay[4])
    };
  }

  const daily = normalized.match(/^(每天|每日)\s*(\d{1,2})(?:[:：点](\d{1,2})?)?分?\s+(.+)$/);
  if (daily?.[2] && daily[4]) {
    const hour = Number(daily[2]);
    const minute = Number(daily[3] ?? 0);
    if (!validClock(hour, minute)) return undefined;
    const label = `每天 ${pad2(hour)}:${pad2(minute)}`;
    return {
      scheduleType: 'daily',
      scheduleSpec: { type: 'daily', hour, minute, label },
      prompt: daily[4].trim(),
      requestedReminder: startsAsReminder(daily[4])
    };
  }

  const weekly = normalized.match(/^每周([一二三四五六日天1-7])\s*(\d{1,2})(?:[:：点](\d{1,2})?)?分?\s+(.+)$/);
  if (weekly?.[1] && weekly[2] && weekly[4]) {
    const hour = Number(weekly[2]);
    const minute = Number(weekly[3] ?? 0);
    if (!validClock(hour, minute)) return undefined;
    const weekday = parseWeekday(weekly[1]);
    if (!weekday) return undefined;
    const label = `每周${weekdayLabel(weekday)} ${pad2(hour)}:${pad2(minute)}`;
    return {
      scheduleType: 'weekly',
      scheduleSpec: { type: 'weekly', weekday, hour, minute, label },
      prompt: weekly[4].trim(),
      requestedReminder: startsAsReminder(weekly[4])
    };
  }

  const interval = normalized.match(/^每\s*(\d+)\s*(分钟|分|小时|钟头|天)\s+(.+)$/);
  if (interval?.[1] && interval[2] && interval[3]) {
    const everyMs = durationMs(Number(interval[1]), interval[2]);
    if (!everyMs) return undefined;
    return {
      scheduleType: 'interval',
      scheduleSpec: {
        type: 'interval',
        everyMs,
        label: `每${interval[1]}${interval[2]}`
      },
      prompt: interval[3].trim(),
      requestedReminder: startsAsReminder(interval[3])
    };
  }

  return undefined;
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

  if (scheduleType === 'daily') {
    if (spec.type !== 'daily') throw new Error('每日自动化规则无效');
    const parts = zonedParts(from, timezone);
    let candidate = makeZonedDate(parts.year, parts.month, parts.day, spec.hour, spec.minute, timezone);
    if (candidate.getTime() <= from.getTime()) {
      const next = addUtcDays(parts.year, parts.month, parts.day, 1);
      candidate = makeZonedDate(next.year, next.month, next.day, spec.hour, spec.minute, timezone);
    }
    return candidate.toISOString();
  }

  if (spec.type !== 'weekly') throw new Error('每周自动化规则无效');
  const parts = zonedParts(from, timezone);
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

function stripAutomationPrefix(text: string): { body: string; requestedReminder: boolean } {
  const normalized = text.trim().replace(/\s+/g, ' ');
  const reminder = normalized.match(/^(?:创建提醒|提醒我|提醒|remind me|remind)[:：]?\s*(.+)$/i);
  if (reminder?.[1]) return { body: reminder[1].trim(), requestedReminder: true };

  const scheduled = normalized.match(/^(?:创建自动化|新增自动化|自动化|定时任务|定时|schedule)[:：]?\s*(.+)$/i);
  if (scheduled?.[1]) return { body: scheduled[1].trim(), requestedReminder: false };

  return { body: normalized, requestedReminder: startsAsReminder(normalized) };
}

function stripActionPrefix(text: string): string {
  return text
    .replace(/^(?:提醒我|提醒|执行|做一下|做|帮我|请|麻烦)[:：]?\s*/i, '')
    .trim();
}

function startsAsReminder(text: string): boolean {
  return /^(?:提醒我|提醒|remind me|remind)/i.test(text.trim());
}

function durationMs(amount: number, unit: string): number | undefined {
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const multiplier =
    unit === '分钟' || unit === '分'
      ? 60 * 1000
      : unit === '小时' || unit === '钟头'
        ? 60 * 60 * 1000
        : unit === '天'
          ? 24 * 60 * 60 * 1000
          : undefined;
  if (!multiplier) return undefined;
  const ms = amount * multiplier;
  if (!Number.isSafeInteger(ms) || ms > maxScheduleOffsetMs) return undefined;
  return ms;
}

function validClock(hour: number, minute: number): boolean {
  return Number.isInteger(hour) && Number.isInteger(minute) && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

function validDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

function buildAutomationName(kind: AutomationKind, prompt: string): string {
  const prefix = kind === 'reminder' ? '提醒' : '定时任务';
  const compact = prompt.replace(/\s+/g, ' ').trim();
  return `${prefix}:${compact.slice(0, 24)}`;
}

function statusLabel(status: AutomationRecord['status']): string {
  switch (status) {
    case 'active':
      return '启用';
    case 'paused':
      return '暂停';
    case 'completed':
      return '已完成';
    case 'failed':
      return '失败';
  }
}

function kindLabel(kind: AutomationKind): string {
  switch (kind) {
    case 'reminder':
      return '提醒';
    case 'scheduled_prompt':
      return '定时请求';
    case 'scheduled_tool':
      return '定时工具';
  }
}

function parseWeekday(value: string): number | undefined {
  const map: Record<string, number> = {
    一: 1,
    '1': 1,
    二: 2,
    '2': 2,
    三: 3,
    '3': 3,
    四: 4,
    '4': 4,
    五: 5,
    '5': 5,
    六: 6,
    '6': 6,
    日: 7,
    天: 7,
    '7': 7
  };
  return map[value];
}

function weekdayLabel(weekday: number): string {
  return ['一', '二', '三', '四', '五', '六', '日'][weekday - 1] ?? String(weekday);
}

function formatDateTime(iso: string, timezone: string): string {
  const parts = zonedParts(new Date(iso), timezone);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)} ${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

function zonedParts(date: Date, timezone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
} {
  const formatter = new Intl.DateTimeFormat('zh-CN-u-ca-gregory', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  const entries = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  return {
    year: Number(entries.year),
    month: Number(entries.month),
    day: Number(entries.day),
    hour: Number(entries.hour),
    minute: Number(entries.minute),
    second: Number(entries.second),
    weekday: weekdayNumber(entries.weekday ?? '')
  };
}

function makeZonedDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string
): Date {
  let date = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  for (let index = 0; index < 3; index += 1) {
    const actual = zonedParts(date, timezone);
    const desiredWall = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
    const actualWall = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
      0
    );
    const delta = desiredWall - actualWall;
    if (delta === 0) break;
    date = new Date(date.getTime() + delta);
  }
  return date;
}

function addUtcDays(
  year: number,
  month: number,
  day: number,
  days: number
): { year: number; month: number; day: number } {
  const date = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0, 0));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  };
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
