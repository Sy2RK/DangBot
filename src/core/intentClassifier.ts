import type { Logger } from 'pino';
import type { ChatTurn, OpenAICompatibleClient } from '../services/llm/openaiCompatibleClient.js';
import type { AttachmentKind, IncomingAttachment, RequestKind } from '../types.js';
import { currentBeijingDateContext } from '../utils/time.js';

const classificationTemperature = 0;

export type AttachmentSource = 'none' | 'current_attachment' | 'recent_attachment';

export interface ClassificationAttachment {
  name: string;
  mimeType: string;
  kind: AttachmentKind;
}

export interface RequestClassification {
  requestType: RequestKind;
  attachmentSource: AttachmentSource;
}

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
  'voice_generation',
  'video_generation',
  'document_generation',
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
  const classification = await classifyRequest(
    prompt,
    attachments,
    [],
    llm,
    logger,
    signal
  );
  return classification.requestType;
}

export async function classifyRequest(
  prompt: string,
  currentAttachments: ClassificationAttachment[],
  recentAttachments: ClassificationAttachment[],
  llm: OpenAICompatibleClient,
  logger: Logger,
  signal?: AbortSignal
): Promise<RequestClassification> {
  if (!llm.configured()) {
    logger.warn('LLM is not configured; defaulting request intent to qa');
    return { requestType: 'qa', attachmentSource: 'none' };
  }

  try {
    const raw = await llm.chat(
      buildClassificationMessages(prompt, currentAttachments, recentAttachments),
      signal,
      {
        temperature: classificationTemperature
      }
    );
    const classification = parseRequestClassification(raw);
    if (classification) {
      return inferMissingAttachmentSource(
        raw,
        classification,
        currentAttachments,
        recentAttachments
      );
    }

    logger.warn({ raw }, 'LLM returned an invalid request intent; defaulting to qa');
    return { requestType: 'qa', attachmentSource: 'none' };
  } catch (error) {
    if (signal?.aborted) throw error;
    logger.warn({ error }, 'failed to classify request intent with LLM; defaulting to qa');
    return { requestType: 'qa', attachmentSource: 'none' };
  }
}

function buildClassificationMessages(
  prompt: string,
  currentAttachments: ClassificationAttachment[],
  recentAttachments: ClassificationAttachment[]
): ChatTurn[] {
  return [
    {
      role: 'system',
      content: [
        '你是小当机器人的请求意图分类器，只负责选择内部 requestType，不要回答用户问题。',
        '必须只输出一个 JSON 对象，格式为 {"requestType":"qa","attachmentSource":"none"}。不要 Markdown，不要解释，不要多余文字。',
        `可选 requestType：${classifiableRequestKinds.join('、')}`,
        '可选 attachmentSource：none、current_attachment、recent_attachment。',
        '分类原则：',
        'qa：普通聊天、解释概念、无需读取附件、无需联网核对的问答。',
        'web_search：用户明确要求搜索、查询、联网核对，或问题依赖最新/当年/实时/外部变化信息，例如政策、公告、天气、价格、赛事、考试日程、分数线、新闻、发布信息。',
        'file_analysis：读取、总结、分析、提取文件、文档、PDF、表格、附件内容。',
        'image_analysis：看图、识图、读图中文字、分析图片或截图。',
        'video_analysis：分析、总结、查看视频内容。',
        'image_generation：生成、绘制、编辑、改图、风格化图片。',
        'voice_generation：把指定文字合成为语音文件、朗读文字、用声音说出一段内容。',
        'video_generation：生成视频、让图片动起来、图生视频、文生视频。',
        'document_generation：用户明确要求把已有回答、刚才润色或翻译后的文字制作成 docx 文档并作为文件发送。',
        'summary：总结近期群聊、归纳讨论、提取群聊待办。',
        'room_minutes：整理群聊纪要或会议纪要。',
        'report：生成报告、汇报材料、正式分析稿。',
        'rewrite：只做文本改写、润色。',
        'translate：只做翻译。',
        'data整理：整理、清洗、归类、结构化数据。',
        '附件来源判断：',
        '1、同一条消息带附件，且任务需要查看或修改它时，attachmentSource=current_attachment。',
        '2、当前消息没有附件，但用户说“这个文件、这篇材料、刚才的文档、帮我润色、帮我翻译、缩减到多少字”等，且最近附件可匹配时，attachmentSource=recent_attachment。',
        '3、用户直接提供了待改写或待翻译的正文，或者任务与附件无关时，attachmentSource=none。',
        '4、润色、改写、缩写、扩写、校对、翻译附件时，requestType 仍分别使用 rewrite 或 translate，不要因为要读取附件而丢掉编辑语义。',
        '5、只要任务依赖附件内容，就不能把 attachmentSource 写成 none。'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        currentBeijingDateContext(),
        `用户请求：${prompt}`,
        `当前消息附件：${formatAttachmentFacts(currentAttachments)}`,
        `该用户最近的有效附件：${formatAttachmentFacts(recentAttachments)}`,
        '请判断 requestType 和 attachmentSource。'
      ].join('\n')
    }
  ];
}

function formatAttachmentFacts(attachments: ClassificationAttachment[]): string {
  if (attachments.length === 0) return '无';
  return attachments
    .map(
      (attachment, index) =>
        `${index + 1}、kind=${attachment.kind} name=${attachment.name} mime=${attachment.mimeType}`
    )
    .join('\n');
}

export function parseRequestKind(raw: string): RequestKind | undefined {
  return parseRequestClassification(raw)?.requestType;
}

export function parseRequestClassification(raw: string): RequestClassification | undefined {
  const cleaned = cleanClassifierOutput(raw);
  const parsed = parseJsonLike(cleaned);
  const candidate =
    typeof parsed === 'string'
      ? parsed
      : (readStringProperty(parsed, 'requestType') ??
        readStringProperty(parsed, 'request_type') ??
        readStringProperty(parsed, 'type') ??
        readStringProperty(parsed, 'intent'));
  const requestType = normalizeRequestKind(candidate ?? cleaned);
  if (!requestType) return undefined;

  const attachmentSource = normalizeAttachmentSource(
    readStringProperty(parsed, 'attachmentSource') ??
      readStringProperty(parsed, 'attachment_source') ??
      readStringProperty(parsed, 'source')
  );
  return { requestType, attachmentSource: attachmentSource ?? 'none' };
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

function normalizeAttachmentSource(candidate?: string): AttachmentSource | undefined {
  const compact = candidate?.trim().toLowerCase();
  if (
    compact === 'none' ||
    compact === 'current_attachment' ||
    compact === 'recent_attachment'
  ) {
    return compact;
  }
  return undefined;
}

function inferMissingAttachmentSource(
  raw: string,
  classification: RequestClassification,
  currentAttachments: ClassificationAttachment[],
  recentAttachments: ClassificationAttachment[]
): RequestClassification {
  if (hasExplicitAttachmentSource(raw)) return classification;

  const expectedKind = expectedAttachmentKind(classification.requestType);
  if (!expectedKind) return classification;
  if (currentAttachments.some((attachment) => attachment.kind === expectedKind)) {
    return { ...classification, attachmentSource: 'current_attachment' };
  }
  if (recentAttachments.some((attachment) => attachment.kind === expectedKind)) {
    return { ...classification, attachmentSource: 'recent_attachment' };
  }
  return classification;
}

function hasExplicitAttachmentSource(raw: string): boolean {
  const parsed = parseJsonLike(cleanClassifierOutput(raw));
  return Boolean(
    readStringProperty(parsed, 'attachmentSource') ??
      readStringProperty(parsed, 'attachment_source') ??
      readStringProperty(parsed, 'source')
  );
}

function expectedAttachmentKind(requestType: RequestKind): AttachmentKind | undefined {
  if (
    ['file_analysis', 'summary', 'rewrite', 'translate', 'report', 'data整理'].includes(
      requestType
    )
  ) {
    return 'file';
  }
  if (requestType === 'image_analysis' || requestType === 'image_generation') return 'image';
  if (requestType === 'video_analysis' || requestType === 'video_generation') return 'video';
  return undefined;
}
