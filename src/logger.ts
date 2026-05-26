import { createWriteStream } from 'node:fs';
import pino, { type Logger } from 'pino';
import type { AppConfig } from './types.js';
import { ensureParentDir } from './utils/fs.js';

export async function createLogger(config: AppConfig): Promise<Logger> {
  await ensureParentDir(config.logging.file);

  const fileStream = createWriteStream(config.logging.file, { flags: 'a' });
  const streams = [
    { stream: process.stdout },
    { stream: fileStream }
  ];

  return pino(
    {
      level: process.env.LOG_LEVEL ?? config.logging.level,
      redact: ['llm.apiKey', 'config.llm.apiKey', '*.apiKey', 'apiKey']
    },
    pino.multistream(streams)
  );
}
