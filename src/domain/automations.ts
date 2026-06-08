import type { Logger } from 'pino';
import type { ChatTurn, OpenAICompatibleClient } from '../services/llm/openaiCompatibleClient.js';
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
const automationParseTemperature = 0;

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

export async function parseAutomationDefinitionWithLlm(
  rawText: string,
  options: {
    now?: Date;
    timezone: string;
    defaultRequestType?: RequestKind;
    llm: OpenAICompatibleClient;
    logger: Logger;
    signal?: AbortSignal;
  }
): Promise<AutomationDefinition | undefined> {
  const now = options.now ?? new Date();
  const timezone = options.timezone;
  if (!rawText.trim()) return undefined;

  if (!options.llm.configured()) {
    options.logger.warn('LLM is not configured; cannot parse automation definition');
    return undefined;
  }

  try {
    const raw = await options.llm.chat(buildAutomationParseMessages(rawText, now, timezone), options.signal, {
      temperature: automationParseTemperature
    });
    const definition = parseAutomationDefinitionFromLlmOutput(raw, {
      now,
      timezone,
      defaultRequestType: options.defaultRequestType,
      rawText
    });
    if (!definition) {
      options.logger.warn({ raw }, 'LLM returned an invalid automation definition');
    }
    return definition;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    options.logger.warn({ error }, 'failed to parse automation definition with LLM');
    return undefined;
  }
}

export function parseAutomationDefinitionFromLlmOutput(
  rawText: string,
  options: { now?: Date; timezone: string; defaultRequestType?: RequestKind; rawText?: string }
): AutomationDefinition | undefined {
  const parsed = parseJsonObject(cleanLlmJsonOutput(rawText));
  if (!parsed) return undefined;

  const valid = readBoolean(parsed, 'valid');
  if (valid === false) return undefined;

  const kind = normalizeAutomationKind(readString(parsed, 'kind'));
  const prompt = normalizePrompt(readString(parsed, 'prompt'));
  const schedule = readRecord(parsed, 'schedule');
  if (!kind || !prompt || !schedule) return undefined;

  const now = options.now ?? new Date();
  const scheduleParts = buildScheduleFromLlm(schedule, now, options.timezone, {
    forceCurrentDate: shouldTreatSecondDayAsToday(options.rawText, now, options.timezone)
      ? zonedParts(now, options.timezone)
      : undefined
  });
  if (!scheduleParts) return undefined;

  const requestType = kind === 'reminder' ? 'qa' : (options.defaultRequestType ?? 'qa');

  return {
    name: buildAutomationName(kind, prompt),
    kind,
    requestType,
    scheduleType: scheduleParts.scheduleType,
    scheduleSpec: scheduleParts.scheduleSpec,
    timezone: options.timezone,
    prompt,
    nextRunAt: computeNextRun(
      scheduleParts.scheduleType,
      scheduleParts.scheduleSpec,
      now,
      options.timezone
    )
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
    '小当的小闹钟',
    automations.map((automation) => {
      const spec = parseScheduleSpec(automation.scheduleSpecJson);
      const next = formatAutomationRunAt(automation.nextRunAt, automation.timezone);
      return `${statusLabel(automation.status)} ${kindLabel(automation.kind)}，${spec.label}，${automation.prompt}。下次蹲点：${next}`;
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

function buildAutomationParseMessages(rawText: string, now: Date, timezone: string): ChatTurn[] {
  const parts = zonedParts(now, timezone);
  const currentLocal = `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)} ${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)} 周${weekdayLabel(parts.weekday)}`;
  return [
    {
      role: 'system',
      content: [
        '你是小当机器人的自动化定时任务解析器，只负责把用户话术解析成内部 JSON，不要回答用户问题。',
        '必须只输出一个 JSON 对象，不要 Markdown，不要解释，不要多余文字。',
        '如果用户没有表达创建提醒、定时任务、自动化，或缺少时间/频率/要做的事，输出 {"valid":false,"reason":"..."}。',
        '合法 JSON schema：',
        '{"valid":true,"kind":"reminder|scheduled_prompt","prompt":"要提醒或要执行的内容","schedule":{"type":"once_relative|once_absolute|daily|weekly|interval"}}',
        'kind 规则：只提醒一句话或事项用 reminder；让机器人定期总结、搜索、生成、分析、执行请求用 scheduled_prompt。',
        'prompt 必须去掉“设置定时任务/提醒我/定时/自动化”等命令词和时间表达，只保留真正要提醒或执行的内容。',
        'schedule 规则：',
        'once_relative：{"type":"once_relative","amount":10,"unit":"minute"}，用于 10 分钟后、2 小时后、3 天后。',
        'once_absolute：{"type":"once_absolute","date":"YYYY-MM-DD","time":"HH:mm"}，用于今天/明天/具体日期的单次任务；相对日期必须按当前本地时间换算成具体日期。',
        '深夜适配：如果当前本地时间早于 04:00，用户说“第二天、第2天、第二日”时，按当天处理，不要按明天处理。',
        'daily：{"type":"daily","time":"HH:mm"}，用于每天/每日。',
        'weekly：{"type":"weekly","weekday":1,"time":"HH:mm"}，weekday 使用 1=周一 ... 7=周日。',
        'interval：{"type":"interval","amount":30,"unit":"minute"}，用于每 30 分钟、每 2 小时、每 1 天重复。',
        'unit 只允许 minute、hour、day。时间使用 24 小时制。不要输出 nextRunAt。'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        `当前时区：${timezone}`,
        `当前本地时间：${currentLocal}`,
        `当前 UTC ISO：${now.toISOString()}`,
        `用户原文：${rawText}`,
        '请解析这个自动化或提醒。'
      ].join('\n')
    }
  ];
}

function buildScheduleFromLlm(
  schedule: Record<string, unknown>,
  now: Date,
  timezone: string,
  options: { forceCurrentDate?: { year: number; month: number; day: number } } = {}
):
  | {
      scheduleType: AutomationScheduleType;
      scheduleSpec: AutomationScheduleSpec;
    }
  | undefined {
  const scheduleType = normalizeLlmScheduleType(readString(schedule, 'type'), schedule);
  if (!scheduleType) return undefined;

  if (scheduleType === 'once_relative') {
    const amount = readPositiveInteger(schedule, 'amount');
    const unit = normalizeDurationUnit(readString(schedule, 'unit'));
    if (!amount || !unit) return undefined;
    const everyMs = durationMs(amount, unit);
    if (!everyMs) return undefined;
    return {
      scheduleType: 'once',
      scheduleSpec: {
        type: 'once',
        at: new Date(now.getTime() + everyMs).toISOString(),
        label: `${amount}${unit}后`
      }
    };
  }

  if (scheduleType === 'once_absolute') {
    const at = readAbsoluteDate(schedule, timezone, options.forceCurrentDate);
    if (!at || !withinScheduleHorizon(at, now)) return undefined;
    return {
      scheduleType: 'once',
      scheduleSpec: {
        type: 'once',
        at: at.toISOString(),
        label: formatDateTime(at.toISOString(), timezone)
      }
    };
  }

  if (scheduleType === 'daily') {
    const clock = readClock(schedule);
    if (!clock) return undefined;
    return {
      scheduleType: 'daily',
      scheduleSpec: {
        type: 'daily',
        hour: clock.hour,
        minute: clock.minute,
        label: `每天 ${pad2(clock.hour)}:${pad2(clock.minute)}`
      }
    };
  }

  if (scheduleType === 'weekly') {
    const clock = readClock(schedule);
    const weekday = normalizeWeekday(readString(schedule, 'weekday') ?? readNumber(schedule, 'weekday'));
    if (!clock || !weekday) return undefined;
    const label = `每周${weekdayLabel(weekday)} ${pad2(clock.hour)}:${pad2(clock.minute)}`;
    return {
      scheduleType: 'weekly',
      scheduleSpec: {
        type: 'weekly',
        weekday,
        hour: clock.hour,
        minute: clock.minute,
        label
      }
    };
  }

  const amount = readPositiveInteger(schedule, 'amount');
  const unit = normalizeDurationUnit(readString(schedule, 'unit'));
  if (!amount || !unit) return undefined;
  const everyMs = durationMs(amount, unit);
  if (!everyMs) return undefined;
  return {
    scheduleType: 'interval',
    scheduleSpec: {
      type: 'interval',
      everyMs,
      label: `每${amount}${unit}`
    }
  };
}

function cleanLlmJsonOutput(rawText: string): string {
  return rawText
    .trim()
    .replaceAll('```json', '')
    .replaceAll('```JSON', '')
    .replaceAll('```', '')
    .trim();
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;

  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return readRecordValue(parsed);
  } catch {
    return undefined;
  }
}

function readRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  return readRecordValue(record[key]);
}

function readRecordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readPositiveInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = readNumber(record, key);
  return value && Number.isInteger(value) && value > 0 ? value : undefined;
}

function normalizePrompt(text?: string): string | undefined {
  const prompt = text?.replace(/\s+/g, ' ').trim();
  return prompt ? prompt : undefined;
}

function normalizeAutomationKind(value?: string): AutomationKind | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'reminder' || normalized === '提醒') return 'reminder';
  if (
    normalized === 'scheduled_prompt' ||
    normalized === 'scheduled' ||
    normalized === 'automation' ||
    normalized === '定时任务' ||
    normalized === '自动化'
  ) {
    return 'scheduled_prompt';
  }
  return undefined;
}

type LlmScheduleType = 'once_relative' | 'once_absolute' | 'daily' | 'weekly' | 'interval';

function normalizeLlmScheduleType(
  value: string | undefined,
  schedule: Record<string, unknown>
): LlmScheduleType | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'once_relative' || normalized === 'relative' || normalized === 'after') {
    return 'once_relative';
  }
  if (normalized === 'once_absolute' || normalized === 'absolute' || normalized === 'at') {
    return 'once_absolute';
  }
  if (normalized === 'daily' || normalized === 'every_day') return 'daily';
  if (normalized === 'weekly' || normalized === 'every_week') return 'weekly';
  if (normalized === 'interval' || normalized === 'every') return 'interval';
  if (normalized === 'once') {
    return readString(schedule, 'at') || readString(schedule, 'date')
      ? 'once_absolute'
      : 'once_relative';
  }
  return undefined;
}

function shouldTreatSecondDayAsToday(
  rawText: string | undefined,
  now: Date,
  timezone: string
): boolean {
  if (!rawText || !/第\s*[二2]\s*[天日]/.test(rawText)) return false;
  return zonedParts(now, timezone).hour < 4;
}

function readAbsoluteDate(
  schedule: Record<string, unknown>,
  timezone: string,
  forceDate?: { year: number; month: number; day: number }
): Date | undefined {
  const at = readString(schedule, 'at') ?? readString(schedule, 'datetime') ?? readString(schedule, 'dateTime');
  if (at) {
    const date = new Date(at);
    if (Number.isNaN(date.getTime())) return undefined;
    if (!forceDate) return date;
    const clock = readClock(schedule) ?? clockFromDate(date, timezone);
    return makeZonedDate(forceDate.year, forceDate.month, forceDate.day, clock.hour, clock.minute, timezone);
  }

  const dateParts = forceDate ?? parseDateParts(readString(schedule, 'date'));
  const clock = readClock(schedule);
  if (!dateParts || !clock) return undefined;
  return makeZonedDate(dateParts.year, dateParts.month, dateParts.day, clock.hour, clock.minute, timezone);
}

function clockFromDate(date: Date, timezone: string): { hour: number; minute: number } {
  const parts = zonedParts(date, timezone);
  return { hour: parts.hour, minute: parts.minute };
}

function parseDateParts(value?: string): { year: number; month: number; day: number } | undefined {
  const parts = value?.trim().replaceAll('/', '-').split('-') ?? [];
  if (parts.length !== 3) return undefined;
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  return validDate(year, month, day) ? { year, month, day } : undefined;
}

function readClock(record: Record<string, unknown>): { hour: number; minute: number } | undefined {
  const hour = readNumber(record, 'hour');
  const minute = readNumber(record, 'minute') ?? 0;
  if (hour !== undefined && validClock(hour, minute)) {
    return { hour, minute };
  }

  const time = readString(record, 'time');
  if (!time) return undefined;
  const parts = time.trim().replace('：', ':').replace('点', ':').replace('分', '').split(':');
  if (parts.length < 1 || parts.length > 2) return undefined;
  const parsedHour = Number(parts[0]);
  const parsedMinute = Number(parts[1] ?? 0);
  return validClock(parsedHour, parsedMinute)
    ? { hour: parsedHour, minute: parsedMinute }
    : undefined;
}

function normalizeDurationUnit(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (['minute', 'minutes', 'min', 'mins', 'm', '分钟', '分'].includes(normalized)) return '分钟';
  if (['hour', 'hours', 'h', '小时', '钟头'].includes(normalized)) return '小时';
  if (['day', 'days', 'd', '天'].includes(normalized)) return '天';
  return undefined;
}

function normalizeWeekday(value: string | number | undefined): number | undefined {
  if (typeof value === 'number') return value >= 1 && value <= 7 ? value : undefined;
  if (!value) return undefined;
  const parsed = parseWeekday(value);
  if (parsed) return parsed;
  const normalized = value.trim().toLowerCase();
  const map: Record<string, number> = {
    monday: 1,
    mon: 1,
    tuesday: 2,
    tue: 2,
    wednesday: 3,
    wed: 3,
    thursday: 4,
    thu: 4,
    friday: 5,
    fri: 5,
    saturday: 6,
    sat: 6,
    sunday: 7,
    sun: 7
  };
  return map[normalized];
}

function withinScheduleHorizon(date: Date, now: Date): boolean {
  const offset = date.getTime() - now.getTime();
  return Number.isFinite(offset) && offset <= maxScheduleOffsetMs;
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
      return '醒着';
    case 'paused':
      return '趴着';
    case 'completed':
      return '跑完啦';
    case 'failed':
      return '摔了一跤';
  }
}

function kindLabel(kind: AutomationKind): string {
  switch (kind) {
    case 'reminder':
      return '小提醒';
    case 'scheduled_prompt':
      return '定时小爪';
    case 'scheduled_tool':
      return '工具小爪';
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
