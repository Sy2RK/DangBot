export interface PlainSource {
  title: string;
  url: string;
}

export const plainTextOutputInstruction = [
  '所有面向群聊的回复都使用微信纯文本。',
  '不要使用 Markdown 标题、粗体、斜体、代码围栏、短横线列表、表格或 Markdown 链接。',
  '需要分点时，用“1、2、3、”这种普通编号；需要给链接时，直接写标题和 URL。',
  '如果用户要求 Markdown，也默认改写成纯文本版本。'
].join('\n');

export const replyPhrases = {
  attachmentRejected: (reason: string) => `这个附件我处理不了：${reason}`,
  roomEnabled: '醒啦。之后你们明确 @ 我，我再伸爪处理。',
  roomDisabled: '我先趴回去了。之后普通请求就不处理啦。',
  userContextCleared: '你的个人上下文清掉啦。',
  roomContextCleared: '本群公共上下文清掉啦。',
  askMemoryContent: '想让我记住什么呀，喵？',
  askGlobalMemoryContent: '想让我全局记住什么呀，喵？',
  memorySaved: '记住啦，喵。',
  globalMemorySaved: '全局记住啦，喵。',
  userMemoryCleared: '你的持久记忆清掉啦。',
  globalMemoryCleared: '全局持久记忆清掉啦。',
  noTaskToCancel: '我没找到可取消的任务。',
  taskCancelled: '已取消。',
  noApprovalTask: '我没找到正在等审批的任务。',
  approvalRejected: '已拒绝。',
  approvalAccepted: '好，我开始处理。',
  emptyPrompt: '我在呢，想让我处理什么？',
  userRateLimited: '这会儿请求有点密，等一下再喊我。',
  roomRateLimited: '群里请求有点多，我先喘口气，稍后再来。',
  typedRateLimited: '这类任务现在有点挤，等一下再试。',
  taskFailed: (reason: string) => `这次没处理成：${reason}`,
  longTextFile: '内容有点长，我放成文本文件发你。',
  emptyTaskResult: '做完啦，不过没有生成可展示的结果。',
  roomNotEnabled: '这个群我还没醒，先让管理员启用一下。',
  operationUnavailable: '这个操作现在还不开放。',
  voiceFileGenerating: '好哒，我这就念给你听，喵～',
  progressReceived: '收到，我先扒拉一下。',
  progressFallbackPlan: '我打算先看清楚你要什么，再把材料和上下文捋一遍，最后给你一个能直接用的结果。',
  progressStage: (detail: string) => `这一步处理完啦：${detail}`,
  progressDoneText: '完成啦，结果在下面。',
  progressDoneFile: '完成啦，结果文件发你。',
  progressDoneLongText: '完成啦，内容有点长，我放成文本文件发你。'
};

export function normalizeOutgoingText(text: string): string {
  const normalized = redactLocalPaths(text).replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';

  const withoutFences = normalized
    .replace(/^```[^\n]*\n?/gm, '')
    .replace(/^~~~[^\n]*\n?/gm, '');
  const withoutTables = normalizeTableLines(withoutFences);
  const lines = withoutTables.split('\n');
  const output: string[] = [];
  let bulletIndex = 1;

  for (const line of lines) {
    const sourceLine = normalizeMarkdownSourceLine(line);
    if (sourceLine) {
      output.push(sourceLine);
      bulletIndex = 1;
      continue;
    }

    const trimmed = stripInlineMarkdown(line).trim();
    if (!trimmed) {
      if (output.at(-1) !== '') output.push('');
      bulletIndex = 1;
      continue;
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      if (output.at(-1) !== '') output.push('');
      bulletIndex = 1;
      continue;
    }

    const heading = trimmed.match(/^#{1,6}\s+(.+)$/);
    if (heading?.[1]) {
      output.push(heading[1].trim());
      bulletIndex = 1;
      continue;
    }

    const bullet = trimmed.match(/^[-*+]\s+(.+)$/);
    if (bullet?.[1]) {
      output.push(`${bulletIndex}、${bullet[1].trim()}`);
      bulletIndex += 1;
      continue;
    }

    const ordered = trimmed.match(/^(\d+)[.)]\s+(.+)$/);
    if (ordered?.[1] && ordered[2]) {
      output.push(`${ordered[1]}、${ordered[2].trim()}`);
      bulletIndex = Number(ordered[1]) + 1;
      continue;
    }

    output.push(trimmed.replace(/^>\s?/, ''));
    bulletIndex = 1;
  }

  return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function redactLocalPaths(text: string): string {
  return text
    .replace(/(?:file:\/\/)?\/Users\/[^\s，。；;]+/g, '[本地路径已隐藏]')
    .replace(/(?:file:\/\/)?\/tmp\/[^\s，。；;]+/g, '[本地路径已隐藏]');
}

export function formatPlainList(title: string, items: string[], emptyText?: string): string {
  if (items.length === 0) return emptyText ?? `${title}还是空的，喵。`;

  return normalizeOutgoingText(
    [`${title}：`, ...items.map((item, index) => `${index + 1}、${item}`)].join('\n')
  );
}

export function formatPlainSources(sources: PlainSource[]): string {
  return sources
    .map((source, index) => formatPlainSource(source, index))
    .filter(Boolean)
    .join('\n');
}

export function appendPlainSources(text: string, sources: PlainSource[]): string {
  const body = normalizeOutgoingText(text);
  const sourceText = formatPlainSources(sources);
  return normalizeOutgoingText([body, sourceText].filter(Boolean).join('\n\n'));
}

function formatPlainSource(source: PlainSource, index: number): string {
  const url = source.url.trim();
  if (!url) return '';

  const title = source.title.trim() || url;
  return `来源 ${index + 1}：${title} ${url}`;
}

function normalizeTableLines(text: string): string {
  const lines: string[] = [];

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (/^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/.test(trimmed)) continue;
    if (/^\|.+\|$/.test(trimmed)) {
      lines.push(
        trimmed
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((cell) => cell.trim())
          .filter(Boolean)
          .join(' / ')
      );
      continue;
    }

    lines.push(line);
  }

  return lines.join('\n');
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]\n]*)\]\(([^)\n]+)\)/g, (_match, alt: string, url: string) =>
      [alt.trim(), url.trim()].filter(Boolean).join(' ')
    )
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 $2')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1')
    .replace(/~~([^~\n]+)~~/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\s+$/g, '');
}

function normalizeMarkdownSourceLine(line: string): string | undefined {
  const inline = stripInlineMarkdown(line).trim();
  const source = inline.match(/^\[(\d+)\]\s+(.+?)\s+(https?:\/\/\S+)$/);
  if (source?.[1] && source[2] && source[3]) {
    return `来源 ${source[1]}：${source[2].trim()} ${source[3].trim()}`;
  }

  const reference = inline.match(/^\[(\d+)\]:\s*(https?:\/\/\S+)$/);
  if (reference?.[1] && reference[2]) {
    return `来源 ${reference[1]}：${reference[2].trim()}`;
  }

  return undefined;
}
