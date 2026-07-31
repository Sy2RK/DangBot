import { z } from 'zod';
import {
  formatWebSearchResultsForLlm,
  type WebSearchResult
} from '../services/search/braveSearchClient.js';
import { currentBeijingDateContext, currentBeijingDateLabel } from '../utils/time.js';
import { appendPlainSources } from '../core/replyStyle.js';
import { redactLocalPaths } from '../core/replyStyle.js';
import type { RequestKind } from '../types.js';
import type { ToolDefinition, ToolExecutionContext } from './registry.js';
import { ToolRegistry } from './registry.js';

const promptInput = z.object({
  prompt: z.string().min(1)
});

const voiceInput = z.object({
  text: z.string().min(1).max(4096)
});

const textPrepareInput = z.object({
  instruction: z.string().min(1).max(1000),
  source: z.string().min(1).max(20_000),
  startMarker: z.string().min(1).max(200).optional(),
  endMarker: z.string().min(1).max(200).optional()
});

export function createBuiltinToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const definition of builtinToolDefinitions()) {
    registry.register(definition);
  }
  return registry;
}

export function toolNameForRequestKind(requestType: RequestKind): string | undefined {
  switch (requestType) {
    case 'web_search':
      return 'web.search';
    case 'file_analysis':
      return 'file.analyze';
    case 'image_analysis':
      return 'image.analyze';
    case 'video_analysis':
      return 'video.analyze';
    case 'image_generation':
      return 'image.generate';
    case 'voice_generation':
      return 'voice.generate';
    case 'video_generation':
      return 'video.generate';
    case 'document_generation':
      return 'document.create';
    default:
      return undefined;
  }
}

export function buildToolInputForRequest(requestType: RequestKind, prompt: string): unknown {
  if (requestType === 'web_search') {
    return { prompt, query: buildWebSearchQuery(prompt) };
  }
  if (requestType === 'voice_generation') {
    return { text: extractSpeechText(prompt) };
  }
  return { prompt };
}

function builtinToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'web.search',
      description: '联网搜索并基于来源回答。',
      inputDescription:
        '{"prompt":"希望搜索结果完成的任务","query":"精确搜索词"}；获取文章正文时，prompt 要求只返回完整正文。',
      inputSchema: promptInput.extend({
        query: z.string().min(1)
      }),
      riskLevel: 'medium',
      allowedRoles: ['member', 'group_admin', 'system_admin'],
      canRunAsSupport: true,
      capabilities: { network: true },
      execute: executeWebSearch
    },
    {
      name: 'file.analyze',
      description: '读取并分析最近或当前文件。',
      inputDescription: '{"prompt":"对文件的具体处理要求"}',
      inputSchema: promptInput,
      riskLevel: 'medium',
      allowedRoles: ['member', 'group_admin', 'system_admin'],
      canRunAsSupport: true,
      execute: executeFileAnalysis
    },
    {
      name: 'document.create',
      description: '把最近相关的已完成文字结果制作成可下载的 DOCX 文件。',
      inputDescription: '{"prompt":"用户希望把哪段已有结果制作成 DOCX"}',
      inputSchema: promptInput,
      riskLevel: 'medium',
      allowedRoles: ['member', 'group_admin', 'system_admin'],
      terminalResult: true,
      execute: executeDocumentCreation
    },
    {
      name: 'image.analyze',
      description: '分析最近或当前图片。',
      inputDescription: '{"prompt":"对图片的具体分析要求"}',
      inputSchema: promptInput,
      riskLevel: 'medium',
      allowedRoles: ['member', 'group_admin', 'system_admin'],
      canRunAsSupport: true,
      execute: executeImageAnalysis
    },
    {
      name: 'video.analyze',
      description: '分析最近或当前视频。',
      inputDescription: '{"prompt":"对视频的具体分析要求"}',
      inputSchema: promptInput,
      riskLevel: 'medium',
      allowedRoles: ['member', 'group_admin', 'system_admin'],
      canRunAsSupport: true,
      execute: executeVideoAnalysis
    },
    {
      name: 'image.generate',
      description: '生成图片或基于参考图改图。',
      inputDescription: '{"prompt":"完整的图片生成要求"}',
      inputSchema: promptInput,
      riskLevel: 'medium',
      allowedRoles: ['member', 'group_admin', 'system_admin'],
      terminalResult: true,
      execute: executeImageGeneration
    },
    {
      name: 'voice.generate',
      description:
        '把已经准备好的最终正文合成为 MP3 语音文件。text 必须是实际朗读正文，不能是作品名、任务说明或搜索结果来源。',
      inputDescription: '{"text":"最终要朗读的完整正文，不能包含命令、作品名占位、来源或解释"}',
      inputSchema: voiceInput,
      riskLevel: 'medium',
      allowedRoles: ['member', 'group_admin', 'system_admin'],
      terminalResult: true,
      capabilities: { network: true },
      execute: executeVoiceGeneration
    },
    {
      name: 'text.prepare',
      description:
        '从已有材料中提取、清理或改写出供下一个工具使用的最终文本，例如从搜索结果中只保留指定作品正文并去掉标题、注释、译文、来源和相邻作品。',
      inputDescription:
        '{"instruction":"要保留什么、去掉什么","source":"上一步得到的原始材料","startMarker":"正文开头原句","endMarker":"正文结尾原句"}；命名作品必须提供起止标记。',
      inputSchema: textPrepareInput,
      riskLevel: 'low',
      allowedRoles: ['member', 'group_admin', 'system_admin'],
      canRunAsSupport: true,
      execute: executeTextPreparation
    },
    {
      name: 'video.generate',
      description: '生成视频或基于图片首帧生成视频。',
      inputDescription: '{"prompt":"完整的视频生成要求"}',
      inputSchema: promptInput,
      riskLevel: 'high',
      allowedRoles: ['member', 'group_admin', 'system_admin'],
      terminalResult: true,
      execute: executeVideoGeneration
    }
  ];
}

async function executeTextPreparation(
  ctx: ToolExecutionContext,
  input: z.infer<typeof textPrepareInput>
) {
  if (input.startMarker || input.endMarker) {
    if (!input.startMarker || !input.endMarker) {
      throw new Error('确定性文本提取必须同时提供 startMarker 和 endMarker。');
    }
    const text = extractBoundedText(input.source, input.startMarker, input.endMarker);
    return { kind: 'text' as const, text, summary: text };
  }

  const text = (
    await ctx.llm.chat(
      [
        {
          role: 'system',
          content: [
            ctx.system.content,
            '你是内部文本提取器。严格按用户给出的边界从材料中提取最终文本。',
            '只输出最终文本本身，不要标题、引言、解释、注释、译文、来源、链接、相邻作品或 Markdown。',
            '不能凭空续写材料里不存在的内容；材料不足时明确返回“材料不足”。'
          ].join('\n\n')
        },
        {
          role: 'user',
          content: [`处理要求：${input.instruction}`, `原始材料：\n${input.source}`].join('\n\n')
        }
      ],
      ctx.signal,
      { temperature: 0 }
    )
  ).trim();
  if (!text || text === '材料不足') {
    throw new Error('现有材料不足以准备后续工具所需的完整文本。');
  }
  return { kind: 'text' as const, text, summary: text };
}

async function executeVoiceGeneration(
  ctx: ToolExecutionContext,
  input: z.infer<typeof voiceInput>
) {
  if (isUnresolvedSpeechReference(input.text)) {
    throw new Error('语音工具收到的是作品名而不是正文，必须先取得完整正文再合成。');
  }
  const voice = await ctx.llm.generateVoice(input.text, ctx.signal);
  return {
    kind: 'file' as const,
    filePath: voice.filePath,
    summary: voice.filePath
  };
}

async function executeImageGeneration(ctx: ToolExecutionContext, input: z.infer<typeof promptInput>) {
  const needsReferenceImage = promptReferencesImageForGeneration(input.prompt);
  const referenceImage = needsReferenceImage ? ctx.pickAttachment('image') : undefined;
  if (needsReferenceImage && !referenceImage) {
    throw new Error('没有找到可用于生成图片的参考图。请先发送图片，或在同一条消息里带上图片。');
  }
  await ctx.stage(referenceImage ? '参考图我拿到啦，准备送去画。' : '描述我看明白啦，准备送去画。');
  const imagePath = await ctx.llm.generateImage(
    input.prompt,
    {
      referenceImagePath: referenceImage?.filePath,
      referenceImageMimeType: referenceImage?.mimeType
    },
    ctx.signal
  );
  await ctx.stage('图已经生成好啦，准备发出来。');
  return { kind: 'image' as const, imagePath, summary: imagePath };
}

async function executeVideoGeneration(ctx: ToolExecutionContext, input: z.infer<typeof promptInput>) {
  const referenceImage = ctx.pickAttachment('image');
  if (promptNeedsReferenceImage(input.prompt) && !referenceImage) {
    throw new Error('没有找到可用于生成视频的参考图。请先发送图片，或在同一条消息里带上图片。');
  }
  await ctx.stage(referenceImage ? '首帧参考图找到了，准备送去做视频。' : '视频描述我看明白啦，准备提交生成。');
  const videoPath = await ctx.llm.generateVideo(
    input.prompt,
    {
      frameImagePath: referenceImage?.filePath,
      frameImageMimeType: referenceImage?.mimeType,
      timeoutMs: ctx.config.limits.videoGenerationTimeoutMs,
      pollIntervalMs: ctx.config.limits.videoGenerationPollIntervalMs
    },
    ctx.signal
  );
  await ctx.stage('视频已经生成好啦，准备发文件。');
  return { kind: 'file' as const, filePath: videoPath, summary: videoPath };
}

async function executeImageAnalysis(ctx: ToolExecutionContext, input: z.infer<typeof promptInput>) {
  const attachment = ctx.pickAttachment('image');
  if (!attachment) {
    throw new Error('没有找到可分析的图片。请先发送图片，或在同一条消息里 @ 我说明要分析什么。');
  }
  await ctx.stage('图片我拿到啦，正在看细节。');
  const text = await ctx.llm.vision(input.prompt, attachment.filePath, attachment.mimeType, ctx.signal, ctx.system.content);
  await ctx.stage('图里的信息已经捋好啦。');
  return { kind: 'text' as const, text, summary: text };
}

async function executeVideoAnalysis(ctx: ToolExecutionContext, input: z.infer<typeof promptInput>) {
  const attachment = ctx.pickAttachment('video');
  if (!attachment) {
    throw new Error('没有找到可分析的视频。请先发送视频，或在同一条消息里 @ 我说明要分析什么。');
  }
  await ctx.stage('视频我拿到啦，正在看里面的内容。');
  const text = await ctx.llm.video(input.prompt, attachment.filePath, attachment.mimeType, ctx.signal, ctx.system.content);
  await ctx.stage('视频里的重点已经捋好啦。');
  return { kind: 'text' as const, text, summary: text };
}

async function executeFileAnalysis(ctx: ToolExecutionContext, input: z.infer<typeof promptInput>) {
  const attachment = ctx.pickAttachment('file');
  if (!attachment) {
    throw new Error('没有找到可处理的文件。请先发送文件，或在同一条消息里 @ 我说明要处理什么。');
  }
  const fileText = await ctx.fileService.extractText(attachment);
  await ctx.stage('文件内容已经读出来啦。');
  const editTask =
    ctx.task.requestType === 'rewrite' || ctx.task.requestType === 'translate'
      ? ctx.task.requestType
      : undefined;
  const text = await ctx.llm.chat(
    [
      editTask
        ? {
            role: 'system',
            content: [
              ctx.system.content,
              '你正在编辑用户提供的文档。',
              '只输出编辑后的完整正文，不要解释、前言、完成提示、文件名、Markdown 代码围栏或额外聊天内容。',
              '尽量保留原文的段落层次、标题和编号；除非用户要求，不要遗漏正文。'
            ].join('\n\n')
          }
        : ctx.system,
      {
        role: 'user',
        content: [
          `用户请求：${input.prompt}`,
          `文件名：${attachment.fileName}`,
          '文件内容：',
          fileText
        ].join('\n\n')
      }
    ],
    ctx.signal,
    { temperature: 0.25 }
  );
  if (editTask) {
    const filePath = await ctx.fileService.writeEditedResult(attachment, text.trim(), editTask);
    if (filePath) {
      await ctx.stage('编辑后的文档已经按原文件类型装好啦。');
      return { kind: 'file' as const, filePath, summary: text };
    }
  }
  await ctx.stage('文件里的重点已经整理好啦。');
  return { kind: 'text' as const, text, summary: text };
}

async function executeDocumentCreation(
  ctx: ToolExecutionContext,
  input: z.infer<typeof promptInput>
) {
  const candidates = ctx.db.listRecentCompletedRoomTextTasks(ctx.task.roomId, ctx.task.id, 8);
  if (candidates.length === 0) {
    throw new Error('没有找到可制作成文档的最近文字结果。请先让我生成或修改正文。');
  }

  await ctx.stage('我找到最近的文字结果啦，正在核对要装进文档的是哪一版。');
  const content = (
    await ctx.llm.chat(
      [
        {
          role: 'system',
          content: [
            ctx.system.content,
            '你正在为内部文档生成工具选择并清理正文。',
            '根据用户当前请求，从候选历史结果中选择最相关的一项。',
            '只输出应该写入 DOCX 的完整正文，不要聊天语气、解释、完成提示、Markdown、[文件结果] 或任何本地路径。',
            '除去候选结果前后的闲聊和介绍，但不要擅自改写正文内容。'
          ].join('\n\n')
        },
        {
          role: 'user',
          content: [
            `当前请求：${input.prompt}`,
            '候选历史结果：',
            ...candidates.map((candidate, index) =>
              [
                `候选 ${index + 1}`,
                `任务类型：${candidate.requestType}`,
                `原请求：${candidate.prompt}`,
                `结果：\n${redactLocalPaths(candidate.resultText ?? '').slice(0, 12_000)}`
              ].join('\n')
            )
          ].join('\n\n')
        }
      ],
      ctx.signal,
      { temperature: 0 }
    )
  ).trim();
  if (!content || content.includes('[本地路径已隐藏]')) {
    throw new Error('没有整理出可写入文档的有效正文。');
  }

  const title = documentTitle(content);
  const filePath = await ctx.fileService.writeDocxResult(title, content);
  await ctx.stage('DOCX 文档已经生成，准备作为微信附件发送。');
  return { kind: 'file' as const, filePath, summary: `${title}.docx` };
}

function documentTitle(content: string): string {
  const firstLine = content
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine?.slice(0, 50) || '小当文档';
}

async function executeWebSearch(
  ctx: ToolExecutionContext,
  input: { prompt: string; query: string }
) {
  const dateContext = currentBeijingDateContext();
  await ctx.stage(`搜索词捋好啦：${input.query}`);

  if (ctx.config.search.provider === 'brave') {
    if (!ctx.webSearch?.configured()) {
      throw new Error('联网搜索尚未配置。请配置 Brave Search API key 后重试。');
    }

    const searchResponse = await ctx.webSearch.search(input.query, ctx.signal);
    const searchContext = formatWebSearchResultsForLlm(searchResponse);
    await ctx.stage('联网结果拿到了，我在核对来源。');
    const text = await ctx.llm.chat(
      [
        ctx.system,
        ...(ctx.roomContext ? [ctx.roomContext] : []),
        {
          role: 'user',
          content: [
            `用户问题：${input.prompt}`,
            `实际搜索词：${searchResponse.query}`,
            dateContext,
            '请只基于下面的联网搜索结果回答；信息不足时明确说明。涉及天气、新闻、价格、赛程等强时效信息时，必须优先核对来源日期是否覆盖当前日期，不要把过期网页里的“今天”当成真正的今天。用微信纯文本，不要使用 Markdown。正文不要自行列来源，来源会由系统另附。',
            `搜索结果：\n${searchContext}`
          ].join('\n\n')
        }
      ],
      ctx.signal,
      { temperature: 0.25 }
    );
    await ctx.stage('回答和来源都整理好啦。');
    return { kind: 'text' as const, text: appendPlainSources(text, searchResponse.results), summary: text };
  }

  if (!ctx.config.search.enabled) {
    throw new Error('联网搜索尚未启用。请在配置中开启 search.enabled。');
  }

  const answer = await ctx.llm.chatWithWebSearch(
    [
      ctx.system,
      ...(ctx.roomContext ? [ctx.roomContext] : []),
      {
        role: 'user',
        content: [
          `用户问题：${input.prompt}`,
          `实际搜索词：${input.query}`,
          dateContext,
          '请联网搜索后回答；信息不足时明确说明。涉及天气、新闻、价格、赛程等强时效信息时，必须优先核对来源日期是否覆盖当前日期，不要把过期网页里的“今天”当成真正的今天。用微信纯文本，不要使用 Markdown。正文不要自行列来源，来源会由系统另附。'
        ].join('\n\n')
      }
    ],
    {
      maxResults: ctx.config.search.count,
      searchContextSize: ctx.config.search.searchContextSize,
      engine: ctx.config.search.engine
    },
    ctx.signal
  );
  await ctx.stage('联网回答和来源都整理好啦。');
  return { kind: 'text' as const, text: appendPlainSources(answer.text, answer.sources as WebSearchResult[]), summary: answer.text };
}

export function buildWebSearchQuery(prompt: string): string {
  const query = prompt
    .replace(
      /^(?:请|麻烦|帮我)?\s*(?:联网|上网)?\s*(?:搜索一下|帮我搜一下|帮我查一下|搜一下|查一下|搜索|搜|帮我搜|帮我查|查询|查找|查资料|查新闻)[:：]?\s*/i,
      ''
    )
    .replace(/^(?:请|麻烦)?\s*(?:帮我)?\s*(?:看一下|看下|看看|看一看)[:：]?\s*/i, '')
    .replace(/^(?:请|麻烦|帮我)?\s*(?:联网|上网)\s*/i, '')
    .replace(/[？?。！!]+$/g, '')
    .trim();
  const normalized = query || prompt.trim();
  if (needsTemporalSearchAnchor(normalized)) {
    return `${normalized} ${currentBeijingDateLabel()}`;
  }
  return normalized;
}

export function extractSpeechText(prompt: string): string {
  const normalized = prompt.trim();
  const quoted = normalized.match(
    /[“"「『](.+?)[”"」』]\s*(?:合成|生成|转换成|做成).*(?:语音|音频)/s
  );
  if (quoted?.[1]?.trim()) return quoted[1].trim();

  const converted = normalized.match(
    /^(?:请|麻烦|帮我)?\s*把\s*(.+?)\s*(?:合成|生成|转换成|做成)\s*(?:语音|音频)\s*[。！!？?]*$/s
  );
  if (converted?.[1]?.trim()) return converted[1].trim();

  const withoutCommand = normalized
    .replace(
      /^(?:请|麻烦|帮我)?\s*(?:生成|合成|制作)\s*(?:一段|一个)?\s*(?:语音|音频)\s*[:：]?\s*/i,
      ''
    )
    .replace(
      /^(?:请|麻烦|帮我)?\s*(?:用|以)\s*(?:语音|声音)\s*(?:说|朗读|读出|念出|播报)?\s*[:：]?\s*/i,
      ''
    )
    .replace(
      /^(?:请|麻烦|帮我)?\s*(?:朗读(?:一下)?|读(?:一下|出来)?|念(?:一下|出来)?|播报)\s*[:：]?\s*/i,
      ''
    )
    .trim();

  return withoutCommand || normalized;
}

export function isUnresolvedSpeechReference(text: string): boolean {
  const normalized = text.trim();
  return /^(?:一下)?\s*《[^》]{1,80}》$/.test(normalized);
}

export function extractBoundedText(
  source: string,
  startMarker: string,
  endMarker: string
): string {
  const start = locateFlexibleMarker(source, startMarker, 0);
  if (!start) {
    throw new Error(`原始材料中没有找到正文开头：${startMarker}`);
  }
  const end = locateFlexibleMarker(source, endMarker, start.end);
  if (!end) {
    throw new Error(`原始材料中没有找到正文结尾：${endMarker}`);
  }
  let endOffset = end.end;
  while (endOffset < source.length && /[，。！？!?；;：:]/.test(source[endOffset] ?? '')) {
    endOffset += 1;
  }
  return source.slice(start.start, endOffset).trim();
}

function locateFlexibleMarker(
  source: string,
  marker: string,
  fromIndex: number
): { start: number; end: number } | undefined {
  const exactStart = source.indexOf(marker, fromIndex);
  if (exactStart >= 0) {
    return { start: exactStart, end: exactStart + marker.length };
  }

  const compactMarker = compactBoundaryText(marker).toLowerCase();
  if (!compactMarker) return undefined;
  const compactChars: string[] = [];
  const originalIndexes: number[] = [];
  for (let index = fromIndex; index < source.length; index += 1) {
    const char = source[index] ?? '';
    if (compactBoundaryText(char)) {
      compactChars.push(char.toLowerCase());
      originalIndexes.push(index);
    }
  }
  const compactSource = compactChars.join('');
  const compactStart = compactSource.indexOf(compactMarker);
  if (compactStart < 0) return undefined;
  const originalStart = originalIndexes[compactStart];
  const originalEnd = originalIndexes[compactStart + compactMarker.length - 1];
  if (originalStart === undefined || originalEnd === undefined) return undefined;
  return { start: originalStart, end: originalEnd + 1 };
}

function compactBoundaryText(text: string): string {
  return text.replace(/[\s，。！？、；：“”‘’（）《》,.!?;:'"()[\]{}\-—]/gu, '');
}

function needsTemporalSearchAnchor(query: string): boolean {
  return /(今天|今日|今年|本年|本年度|明年|去年|明天|昨天|昨日|本周|这周|本月|最近|当前|现在|实时|最新|天气|预报|新闻|价格|汇率|赛程|股价|政策|公告|发布|上线|更新)/i.test(query);
}

function promptNeedsReferenceImage(prompt: string): boolean {
  return /(这张图|这张图片|这张照片|这个图|刚才的图|刚才图片|刚才照片|上一张|上张|参考图|原图|图生视频|image[- ]?to[- ]?video|把.+动起来|让.+动起来|使.+动起来|让(?:它|他|她).*(?:跳|舞|走|跑|转|眨眼|挥手|说话|唱歌|表演|摇摆|飞)|把(?:它|他|她).*(?:跳|舞|走|跑|转|眨眼|挥手|说话|唱歌|表演|摇摆|飞)|animate)/i.test(prompt);
}

function promptReferencesImageForGeneration(prompt: string): boolean {
  return /(这张图|这张图片|这张照片|这个图|这个图片|上一张|上张|前一张|刚才的图|刚才图片|刚才的照片|刚刚的图|参考图|参考图片|原图|照片中|图片中|图里|照片里|按照这张|参考这张|基于这张|用这张|把它|把他|把她|让它|让他|让她)/i.test(prompt);
}
