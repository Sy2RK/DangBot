import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Document, Packer, Paragraph } from 'docx';
import mammoth from 'mammoth';
import { describe, expect, it } from 'vitest';
import { FileService } from '../src/services/files/fileService.js';
import type { AttachmentRecord } from '../src/types.js';
import { makeTestConfig } from './helpers.js';

describe('FileService edited outputs', () => {
  it('writes edited DOCX content as a readable DOCX file', async () => {
    const config = await makeTestConfig();
    const service = new FileService(config);
    const sourcePath = path.join(config.storage.uploadsDir, '发言材料.docx');
    await mkdir(config.storage.uploadsDir, { recursive: true });
    await writeFile(
      sourcePath,
      await Packer.toBuffer(
        new Document({
          sections: [{ children: [new Paragraph('原始正文')] }]
        })
      )
    );

    const outputPath = await service.writeEditedResult(
      attachmentRecord(sourcePath, '发言材料.docx'),
      '润色后的标题\n\n润色后的完整正文。',
      'rewrite'
    );

    expect(outputPath).toBeDefined();
    expect(path.extname(outputPath!)).toBe('.docx');
    const parsed = await mammoth.extractRawText({ buffer: await readFile(outputPath!) });
    expect(parsed.value).toContain('润色后的标题');
    expect(parsed.value).toContain('润色后的完整正文。');
  });

  it('writes a standalone DOCX result that can be uploaded', async () => {
    const config = await makeTestConfig();
    const service = new FileService(config);

    const outputPath = await service.writeDocxResult(
      '测试文档',
      '测试标题\n\n测试正文'
    );

    const parsed = await mammoth.extractRawText({ path: outputPath });
    expect(path.basename(outputPath)).toMatch(/^测试文档_\d+\.docx$/);
    expect(parsed.value).toContain('测试标题');
    expect(parsed.value).toContain('测试正文');
  });
});

function attachmentRecord(filePath: string, fileName: string): AttachmentRecord {
  return {
    id: 'att_test',
    roomId: 'room1',
    userId: 'user1',
    fileName,
    filePath,
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    sizeBytes: 1,
    hash: 'hash',
    kind: 'file',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  };
}
