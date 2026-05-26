import { createHash } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export async function ensureParentDir(filePath: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
}

export async function fileSize(filePath: string): Promise<number> {
  const info = await stat(filePath);
  return info.size;
}

export async function sha256File(filePath: string): Promise<string> {
  const { createReadStream } = await import('node:fs');
  const hash = createHash('sha256');

  await new Promise<void>((resolve, reject) => {
    createReadStream(filePath)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', resolve);
  });

  return hash.digest('hex');
}

export function safeFileName(name: string): string {
  const cleaned = name.replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 120) : 'file';
}

export function resolveFromCwd(inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(process.cwd(), inputPath);
}
