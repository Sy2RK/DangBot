import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import mammoth from 'mammoth';
import { lookup } from 'mime-types';
import * as XLSX from 'xlsx';
import type { AppConfig, AttachmentKind, AttachmentRecord, IncomingAttachment } from '../../types.js';
import { ensureDir, safeFileName, sha256File } from '../../utils/fs.js';
import { addHoursIso, nowIso } from '../../utils/time.js';

const supportedTextExts = new Set(['.txt', '.md', '.csv']);
const supportedDocExts = new Set(['.docx', '.pdf', '.xlsx']);
const supportedImageExts = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const supportedVideoExts = new Set(['.mp4', '.mpeg', '.mpg', '.mov', '.webm', '.m4v']);

export class FileService {
  constructor(private readonly config: AppConfig) {}

  isSupported(fileName: string): boolean {
    const ext = path.extname(fileName).toLowerCase();
    return (
      supportedTextExts.has(ext) ||
      supportedDocExts.has(ext) ||
      supportedImageExts.has(ext) ||
      supportedVideoExts.has(ext)
    );
  }

  classify(fileName: string, mimeType = ''): AttachmentKind {
    const ext = path.extname(fileName).toLowerCase();
    if (mimeType.startsWith('image/') || supportedImageExts.has(ext)) return 'image';
    if (mimeType.startsWith('video/') || supportedVideoExts.has(ext)) return 'video';
    return 'file';
  }

  async validateAttachment(attachment: IncomingAttachment): Promise<void> {
    if (!this.isSupported(attachment.name)) {
      throw new Error(`暂不支持 ${path.extname(attachment.name) || '该'} 文件类型。`);
    }

    const limit = limitForKind(attachment.kind, this.config);
    if (attachment.sizeBytes > limit) {
      throw new Error(`文件过大，当前限制为 ${formatBytes(limit)}。`);
    }
  }

  async toAttachmentRecord(input: {
    attachment: IncomingAttachment;
    roomId: string;
    userId: string;
    messageId?: string;
  }): Promise<AttachmentRecord> {
    const hash = await sha256File(input.attachment.path);
    return {
      id: `att_${randomUUID()}`,
      roomId: input.roomId,
      userId: input.userId,
      messageId: input.messageId,
      fileName: input.attachment.name,
      filePath: input.attachment.path,
      mimeType: input.attachment.mimeType,
      sizeBytes: input.attachment.sizeBytes,
      hash,
      kind: input.attachment.kind,
      createdAt: nowIso(),
      expiresAt: addHoursIso(this.config.limits.attachmentTtlHours)
    };
  }

  async extractText(record: AttachmentRecord): Promise<string> {
    const ext = path.extname(record.fileName).toLowerCase();
    if (supportedTextExts.has(ext)) {
      return readUtf8WithLimit(record.filePath);
    }

    if (ext === '.docx') {
      const result = await mammoth.extractRawText({ path: record.filePath });
      return normalizeExtractedText(result.value);
    }

    if (ext === '.pdf') {
      const { PDFParse } = await import('pdf-parse');
      const buffer = await readFile(record.filePath);
      const parser = new PDFParse({ data: buffer });
      try {
        const result = await parser.getText();
        return normalizeExtractedText(result.text);
      } finally {
        await parser.destroy();
      }
    }

    if (ext === '.xlsx') {
      const workbook = XLSX.readFile(record.filePath);
      const parts = workbook.SheetNames.map((sheetName) => {
        const sheet = workbook.Sheets[sheetName];
        if (!sheet) return '';
        return `# ${sheetName}\n${XLSX.utils.sheet_to_csv(sheet).trim()}`;
      });
      return normalizeExtractedText(parts.join('\n\n'));
    }

    throw new Error('该文件类型暂不支持文本提取。');
  }

  async writeMarkdownResult(title: string, content: string): Promise<string> {
    await ensureDir(this.config.storage.outputsDir);
    const fileName = `${safeFileName(title)}_${Date.now()}.md`;
    const filePath = path.join(this.config.storage.outputsDir, fileName);
    await writeFile(filePath, content, 'utf8');
    return filePath;
  }

  async writeTextAsXlsx(title: string, rows: Array<Record<string, string | number>>): Promise<string> {
    await ensureDir(this.config.storage.outputsDir);
    const fileName = `${safeFileName(title)}_${Date.now()}.xlsx`;
    const filePath = path.join(this.config.storage.outputsDir, fileName);
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Result');
    XLSX.writeFile(workbook, filePath);
    return filePath;
  }

  guessMimeType(fileName: string): string {
    return lookup(fileName) || 'application/octet-stream';
  }
}

function limitForKind(kind: AttachmentKind, config: AppConfig): number {
  switch (kind) {
    case 'image':
      return config.limits.maxImageBytes;
    case 'video':
      return config.limits.maxVideoBytes;
    case 'file':
      return config.limits.maxFileBytes;
  }
}

async function readUtf8WithLimit(filePath: string): Promise<string> {
  const content = await readFile(filePath, 'utf8');
  return normalizeExtractedText(content);
}

function normalizeExtractedText(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return normalized.length > 80_000 ? `${normalized.slice(0, 80_000)}\n\n[内容过长，已截断。]` : normalized;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${Math.round(bytes / 1024 / 1024)}MB`;
}
