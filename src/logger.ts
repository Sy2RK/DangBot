import { createWriteStream } from 'node:fs';
import pino, { type Logger } from 'pino';
import type { AppConfig } from './types.js';
import { ensureParentDir } from './utils/fs.js';
import { sanitizeLogObject } from './utils/redaction.js';

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
      redact: [
        '*.apiKey',
        'apiKey',
        '*.token',
        'token',
        '*.sessionKey',
        'sessionKey',
        '*.contextId',
        'contextId'
      ],
      formatters: {
        log(object) {
          return sanitizeLogObject(object) as Record<string, unknown>;
        }
      }
    },
    pino.multistream(streams)
  );
}
