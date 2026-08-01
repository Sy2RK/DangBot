import path from 'node:path';
import mammoth from 'mammoth';
import { describe, expect, it } from 'vitest';
import { FileService } from '../src/services/files/fileService.js';
import type { AttachmentRecord } from '../src/types.js';
import { makeTestConfig } from './helpers.js';

describe('FileService deterministic document rendering', () => {
  it('writes a standalone DOCX result that can be uploaded', async () => {
    const config = await makeTestConfig();
    const service = new FileService(config);

    const outputPath = await service.writeDocumentResult(
      '测试文档',
      '测试标题\n\n测试正文',
      'docx'
    );

    const parsed = await mammoth.extractRawText({ path: outputPath });
    expect(path.basename(outputPath)).toMatch(/^测试文档_\d+\.docx$/);
    expect(parsed.value).toContain('测试标题');
    expect(parsed.value).toContain('测试正文');
  });

  it('rechecks attachment root, MIME, size and hash before tool use', async () => {
    const config = await makeTestConfig();
    const service = new FileService(config);
    await mkdir(config.storage.uploadsDir, { recursive: true });
    const filePath = path.join(config.storage.uploadsDir, 'safe.txt');
    await writeFile(filePath, 'safe text');
    const record: AttachmentRecord = {
      id: 'att_safe1234',
      roomId: 'room1',
      userId: 'user1',
      fileName: 'safe.txt',
      filePath,
      mimeType: 'text/plain',
      sizeBytes: 9,
      hash: createHash('sha256').update('safe text').digest('hex'),
      kind: 'file',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    };
    await expect(service.verifyAttachment(record)).resolves.toMatchObject({ id: record.id });
    await writeFile(filePath, 'changed text');
    await expect(service.verifyAttachment(record)).rejects.toThrow(/大小已变化|哈希校验失败/);

    const fakePng = path.join(config.storage.uploadsDir, 'fake.png');
    await writeFile(fakePng, 'plain text');
    await expect(
      service.validateAttachment({
        name: 'fake.png',
        path: fakePng,
        mimeType: 'image/png',
        sizeBytes: 10,
        kind: 'image'
      })
    ).rejects.toThrow(/内容类型/);
  });
});
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
