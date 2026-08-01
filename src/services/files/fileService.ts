import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
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
    const info = await stat(attachment.path);
    if (!info.isFile() || info.size !== attachment.sizeBytes) {
      throw new Error('附件大小或文件类型与下载结果不一致。');
    }
    await assertAttachmentContent(attachment.path, attachment.name, attachment.mimeType);
  }

  async verifyAttachment(record: AttachmentRecord): Promise<AttachmentRecord> {
    const [root, resolved] = await Promise.all([
      realpath(this.config.storage.uploadsDir),
      realpath(record.filePath)
    ]);
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('附件路径越过了 DangBot 上传目录。');
    }
    const info = await stat(resolved);
    if (!info.isFile() || info.size !== record.sizeBytes) throw new Error('附件大小已变化。');
    if (await sha256File(resolved) !== record.hash) throw new Error('附件哈希校验失败。');
    await assertAttachmentContent(resolved, record.fileName, record.mimeType);
    return { ...record, filePath: resolved };
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
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(record.filePath);
      const parts = workbook.worksheets.map((worksheet) => {
        const rows: string[] = [];
        const columnCount = worksheet.actualColumnCount || worksheet.columnCount;
        worksheet.eachRow((row) => {
          const cells: string[] = [];
          for (let column = 1; column <= columnCount; column += 1) {
            cells.push(csvEscape(cellValueToText(row.getCell(column).value)));
          }
          rows.push(cells.join(','));
        });
        return `# ${worksheet.name}\n${rows.join('\n').trim()}`;
      });
      return normalizeExtractedText(parts.join('\n\n'));
    }

    throw new Error('该文件类型暂不支持文本提取。');
  }

  async writeDocumentResult(
    title: string,
    content: string,
    format: 'docx' | 'txt' | 'md'
  ): Promise<string> {
    await ensureDir(this.config.storage.outputsDir);
    const filePath = path.join(
      this.config.storage.outputsDir,
      `${safeFileName(title)}_${Date.now()}.${format}`
    );
    await writeFile(filePath, format === 'docx' ? await buildDocxBuffer(content) : content);
    return filePath;
  }
}

async function buildDocxBuffer(content: string): Promise<Buffer> {
  const paragraphs = content.split('\n').map(
    (line) =>
      new Paragraph({
        children: line ? [new TextRun(line)] : []
      })
  );
  const document = new Document({
    sections: [{ children: paragraphs.length > 0 ? paragraphs : [new Paragraph('')] }]
  });
  return Packer.toBuffer(document);
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
  return text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function cellValueToText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return String(value);
  if ('result' in value) return cellValueToText(value.result as ExcelJS.CellValue);
  if ('text' in value && typeof value.text === 'string') return value.text;
  if ('richText' in value && Array.isArray(value.richText)) {
    return value.richText.map((part) => part.text).join('');
  }
  return JSON.stringify(value);
}

function csvEscape(value: string): string {
  if (!/[",\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${Math.round(bytes / 1024 / 1024)}MB`;
}

async function assertAttachmentContent(filePath: string, fileName: string, mimeType: string): Promise<void> {
  const extension = path.extname(fileName).toLowerCase();
  const file = await readFile(filePath);
  const header = file.subarray(0, Math.min(file.length, 8_192));
  const matches =
    supportedTextExts.has(extension)
      ? !header.includes(0)
      : extension === '.pdf'
        ? header.subarray(0, 5).toString('ascii') === '%PDF-'
        : extension === '.docx' || extension === '.xlsx'
          ? isZip(header)
          : extension === '.png'
            ? header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
            : extension === '.jpg' || extension === '.jpeg'
              ? header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff
              : extension === '.webp'
                ? header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP'
                : extension === '.webm'
                  ? header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
                  : extension === '.mp4' || extension === '.m4v' || extension === '.mov'
                    ? header.subarray(4, 8).toString('ascii') === 'ftyp'
                    : extension === '.mpeg' || extension === '.mpg'
                      ? header[0] === 0x00 && header[1] === 0x00 && header[2] === 0x01
                      : false;
  if (!matches || !mimeMatchesExtension(extension, mimeType)) {
    throw new Error('附件内容类型、扩展名或 MIME 不一致。');
  }
}

function isZip(header: Buffer): boolean {
  return (
    header[0] === 0x50 &&
    header[1] === 0x4b &&
    [0x03, 0x05, 0x07].includes(header[2] ?? -1) &&
    [0x04, 0x06, 0x08].includes(header[3] ?? -1)
  );
}

function mimeMatchesExtension(extension: string, mimeType: string): boolean {
  const allowed: Record<string, string[]> = {
    '.txt': ['text/plain'],
    '.md': ['text/markdown', 'text/plain'],
    '.csv': ['text/csv', 'text/plain'],
    '.png': ['image/png'],
    '.jpg': ['image/jpeg'],
    '.jpeg': ['image/jpeg'],
    '.webp': ['image/webp'],
    '.mp4': ['video/mp4'],
    '.m4v': ['video/mp4', 'video/x-m4v'],
    '.mov': ['video/quicktime', 'video/mov'],
    '.webm': ['video/webm'],
    '.mpeg': ['video/mpeg'],
    '.mpg': ['video/mpeg'],
    '.pdf': ['application/pdf'],
    '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
  };
  return allowed[extension]?.includes(mimeType.toLowerCase()) ?? false;
}
