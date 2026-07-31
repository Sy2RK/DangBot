import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import { lookup } from 'mime-types';
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

  async writeTextResult(title: string, content: string): Promise<string> {
    await ensureDir(this.config.storage.outputsDir);
    const fileName = `${safeFileName(title)}_${Date.now()}.txt`;
    const filePath = path.join(this.config.storage.outputsDir, fileName);
    await writeFile(filePath, content, 'utf8');
    return filePath;
  }

  async writeEditedResult(
    source: AttachmentRecord,
    content: string,
    operation: 'rewrite' | 'translate'
  ): Promise<string | undefined> {
    const ext = path.extname(source.fileName).toLowerCase();
    if (!['.txt', '.md', '.docx'].includes(ext)) return undefined;

    await ensureDir(this.config.storage.outputsDir);
    const baseName = safeFileName(path.basename(source.fileName, ext));
    const label = operation === 'translate' ? '翻译版' : '润色版';
    const filePath = path.join(
      this.config.storage.outputsDir,
      `${baseName}_${label}_${Date.now()}${ext}`
    );

    if (ext === '.docx') {
      await writeFile(filePath, await buildDocxBuffer(content));
      return filePath;
    }

    await writeFile(filePath, content, 'utf8');
    return filePath;
  }

  async writeDocxResult(title: string, content: string): Promise<string> {
    await ensureDir(this.config.storage.outputsDir);
    const filePath = path.join(
      this.config.storage.outputsDir,
      `${safeFileName(title)}_${Date.now()}.docx`
    );
    await writeFile(filePath, await buildDocxBuffer(content));
    return filePath;
  }

  async writeTextAsXlsx(title: string, rows: Array<Record<string, string | number>>): Promise<string> {
    await ensureDir(this.config.storage.outputsDir);
    const fileName = `${safeFileName(title)}_${Date.now()}.xlsx`;
    const filePath = path.join(this.config.storage.outputsDir, fileName);
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Result');
    const headers = rows[0] ? Object.keys(rows[0]) : [];
    if (headers.length > 0) {
      worksheet.addRow(headers);
      for (const row of rows) {
        worksheet.addRow(headers.map((header) => row[header] ?? ''));
      }
    }
    await workbook.xlsx.writeFile(filePath);
    return filePath;
  }

  guessMimeType(fileName: string): string {
    return lookup(fileName) || 'application/octet-stream';
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
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return normalized.length > 80_000 ? `${normalized.slice(0, 80_000)}\n\n[内容过长，已截断。]` : normalized;
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
