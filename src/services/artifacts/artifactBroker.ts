import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import mime from 'mime-types';
import type { AppDatabase } from '../../storage/database.js';
import type { AppConfig, ArtifactKind, ArtifactRecord } from '../../types.js';

export interface ArtifactCandidateResult {
  filePath?: string;
  imagePath?: string;
}

export class ArtifactBroker {
  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase
  ) {}

  async registerToolResult(
    taskId: string,
    runId: string | undefined,
    result: ArtifactCandidateResult
  ): Promise<ArtifactRecord[]> {
    const candidates = [
      result.imagePath ? { filePath: result.imagePath, kind: 'image' as const } : undefined,
      result.filePath ? { filePath: result.filePath, kind: undefined } : undefined
    ].filter((entry): entry is { filePath: string; kind: 'image' | undefined } => Boolean(entry));

    const artifacts: ArtifactRecord[] = [];
    for (const candidate of candidates) {
      const verified = await this.verifyOutputPath(candidate.filePath);
      const mimeType = mime.lookup(verified.filePath) || 'application/octet-stream';
      await assertArtifactContent(verified.filePath, mimeType);
      const inferredKind = artifactKindFromMime(mimeType);
      if (candidate.kind === 'image' && inferredKind !== 'image') {
        throw new Error('图片产物的 MIME 类型不可信，拒绝登记。');
      }
      const kind = candidate.kind ?? inferredKind;
      this.assertSizeAllowed(kind, verified.sizeBytes);
      const sha256 = await hashFile(verified.filePath);
      artifacts.push(
        this.db.addArtifact({
          taskId,
          runId,
          kind,
          filePath: verified.filePath,
          displayName: path.basename(verified.filePath),
          mimeType,
          sizeBytes: verified.sizeBytes,
          sha256,
          ttlMs: this.config.limits.attachmentTtlHours * 60 * 60 * 1_000
        })
      );
    }
    return artifacts;
  }

  async resolveForDelivery(artifact: ArtifactRecord): Promise<ArtifactRecord> {
    const verified = await this.verifyOutputPath(artifact.filePath);
    const mimeType = mime.lookup(verified.filePath) || 'application/octet-stream';
    await assertArtifactContent(verified.filePath, mimeType);
    if (mimeType !== artifact.mimeType) throw new Error('产物 MIME 类型已变化，拒绝发送。');
    const inferredKind = artifactKindFromMime(mimeType);
    if (artifact.kind !== 'file' && inferredKind !== artifact.kind) {
      throw new Error('产物类型校验失败，拒绝发送。');
    }
    this.assertSizeAllowed(artifact.kind, verified.sizeBytes);
    if (verified.sizeBytes !== artifact.sizeBytes) throw new Error('产物大小已变化，拒绝发送。');
    const hash = await hashFile(verified.filePath);
    if (hash !== artifact.sha256) throw new Error('产物校验失败，拒绝发送。');
    return { ...artifact, filePath: verified.filePath };
  }

  private async verifyOutputPath(
    filePath: string
  ): Promise<{ filePath: string; sizeBytes: number }> {
    const [root, resolved] = await Promise.all([
      realpath(this.config.storage.outputsDir),
      realpath(filePath)
    ]);
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      if (!relative) {
        throw new Error('产物必须是输出目录内的文件，不能是目录本身。');
      }
      throw new Error('产物路径越过了 DangBot 输出目录。');
    }
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error('产物不是普通文件。');
    if (info.size <= 0) throw new Error('产物文件为空。');
    return { filePath: resolved, sizeBytes: info.size };
  }

  private assertSizeAllowed(kind: ArtifactKind, sizeBytes: number): void {
    const limit =
      kind === 'image'
        ? this.config.limits.maxImageBytes
        : kind === 'video'
          ? this.config.limits.maxVideoBytes
          : this.config.limits.maxFileBytes;
    if (sizeBytes > limit) throw new Error(`${kind} 产物超过发送限制。`);
  }
}

function artifactKindFromMime(mimeType: string): ArtifactKind {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return 'file';
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function assertArtifactContent(filePath: string, mimeType: string): Promise<void> {
  const header = await readHeader(filePath, 8_192);
  const valid = mimeType.startsWith('text/')
    ? !header.includes(0)
    : mimeType === 'application/pdf'
      ? header.subarray(0, 5).toString('ascii') === '%PDF-'
      : mimeType.includes('openxmlformats-officedocument')
        ? header[0] === 0x50 && header[1] === 0x4b
        : mimeType === 'image/png'
          ? header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
          : mimeType === 'image/jpeg'
            ? header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff
            : mimeType === 'image/webp'
              ? header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP'
              : mimeType.startsWith('audio/')
                ? header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WAVE'
                : mimeType.startsWith('video/')
                  ? header.subarray(4, 8).toString('ascii') === 'ftyp'
                  : false;
  if (!valid) throw new Error('产物内容与 MIME 类型不一致，拒绝登记或发送。');
}

async function readHeader(filePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
