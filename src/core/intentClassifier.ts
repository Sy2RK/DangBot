import type { Logger } from 'pino';
import type { ChatTurn, OpenAICompatibleClient } from '../services/llm/openaiCompatibleClient.js';
import type { IncomingAttachment, RequestKind } from '../types.js';
import { currentBeijingDateContext } from '../utils/time.js';

const classificationTemperature = 0;

export const classifiableRequestKinds: RequestKind[] = [
  'qa',
  'summary',
  'rewrite',
  'translate',
  'web_search',
  'file_analysis',
  'image_analysis',
  'video_analysis',
  'image_generation',
  'video_generation',
  'report',
  'room_minutes',
  'data整理'
];

const requestKindByLowercase = new Map(
  classifiableRequestKinds.map((requestKind) => [requestKind.toLowerCase(), requestKind])
);

export async function classifyRequestKind(
  prompt: string,
  attachments: IncomingAttachment[],
  llm: OpenAICompatibleClient,
  logger: Logger,
  signal?: AbortSignal
): Promise<RequestKind> {
  if (!llm.configured()) {
    logger.warn('LLM is not configured; defaulting request intent to qa');
    return 'qa';
  }

  try {
    const raw = await llm.chat(buildClassificationMessages(prompt, attachments), signal, {
      temperature: classificationTemperature
    });
    const requestType = parseRequestKind(raw);
    if (requestType) return requestType;

    logger.warn({ raw }, 'LLM returned an invalid request intent; defaulting to qa');
    return 'qa';
  } catch (error) {
    if (signal?.aborted) throw error;
    logger.warn({ error }, 'failed to classify request intent with LLM; defaulting to qa');
    return 'qa';
  }
}

function buildClassificationMessages(
  prompt: string,
  attachments: IncomingAttachment[]
): ChatTurn[] {
  return [
    {
      role: 'system',
      content: [
        '你是小当机器人的请求意图分类器，只负责选择内部 requestType，不要回答用户问题。',
        '必须只输出一个 JSON 对象，格式为 {"requestType":"qa"}。不要 Markdown，不要解释，不要多余文字。',
        `可选 requestType：${classifiableRequestKinds.join('、')}`,
        '分类原则：',
        'qa：普通聊天、解释概念、无需读取附件、无需联网核对的问答。',
        'web_search：用户明确要求搜索、查询、联网核对，或问题依赖最新/当年/实时/外部变化信息，例如政策、公告、天气、价格、赛事、考试日程、分数线、新闻、发布信息。',
        'file_analysis：读取、总结、分析、提取文件、文档、PDF、表格、附件内容。',
        'image_analysis：看图、识图、读图中文字、分析图片或截图。',
        'video_analysis：分析、总结、查看视频内容。',
        'image_generation：生成、绘制、编辑、改图、风格化图片。',
        'video_generation：生成视频、让图片动起来、图生视频、文生视频。',
        'summary：总结近期群聊、归纳讨论、提取群聊待办。',
        'room_minutes：整理群聊纪要或会议纪要。',
        'report：生成报告、汇报材料、正式分析稿。',
        'rewrite：只做文本改写、润色。',
        'translate：只做翻译。',
        'data整理：整理、清洗、归类、结构化数据。'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        currentBeijingDateContext(),
        `用户请求：${prompt}`,
        `附件：${formatAttachmentFacts(attachments)}`,
        '请判断 requestType。'
      ].join('\n')
    }
  ];
}

function formatAttachmentFacts(attachments: IncomingAttachment[]): string {
  if (attachments.length === 0) return '无';
  return attachments
    .map(
      (attachment, index) =>
        `${index + 1}、kind=${attachment.kind} name=${attachment.name} mime=${attachment.mimeType}`
    )
    .join('\n');
}

export function parseRequestKind(raw: string): RequestKind | undefined {
  const cleaned = cleanClassifierOutput(raw);
  const parsed = parseJsonLike(cleaned);
  const candidate =
    typeof parsed === 'string'
      ? parsed
      : readStringProperty(parsed, 'requestType') ??
        readStringProperty(parsed, 'request_type') ??
        readStringProperty(parsed, 'type') ??
        readStringProperty(parsed, 'intent');
  return normalizeRequestKind(candidate ?? cleaned);
}

function cleanClassifierOutput(raw: string): string {
  return raw
    .trim()
    .replaceAll('```json', '')
    .replaceAll('```JSON', '')
    .replaceAll('```', '')
    .trim();
}

function parseJsonLike(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return text;
  }

  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return text;
  }
}

function readStringProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const property = record[key];
  return typeof property === 'string' ? property : undefined;
}

function normalizeRequestKind(candidate: string): RequestKind | undefined {
  const compact = candidate.trim();
  if (!compact) return undefined;
  return classifiableRequestKinds.find((requestKind) => requestKind === compact)
    ?? requestKindByLowercase.get(compact.toLowerCase());
}
