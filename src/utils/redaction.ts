const hostPathPattern = /(?:file:\/\/)?\/(?:Users|home|private|tmp|var\/folders|Volumes)\/[^\s\uFF0C\u3002\uFF1B;]+/giu;
const windowsPathPattern = /[A-Za-z]:\\[^\s\uFF0C\u3002\uFF1B;]+/gu;
const apiKeyPattern = /\bsk-[A-Za-z0-9._-]{8,}\b/gu;

export function redactSensitiveText(value: string, maxLength = 1_000): string {
  return value
    .replace(hostPathPattern, '[host path redacted]')
    .replace(windowsPathPattern, '[host path redacted]')
    .replace(/Bearer\s+\S+/giu, 'Bearer [secret redacted]')
    .replace(apiKeyPattern, '[secret redacted]')
    .replace(/dangbot:[a-f0-9]{24,}/giu, 'dangbot:[session redacted]')
    .replace(/(?:contextId|sessionKey|apiKey|token)\s*[:=]\s*[^\s,}\]]+/giu, '$1=[secret redacted]')
    .slice(0, maxLength);
}

export function safeErrorSummary(error: unknown, maxLength = 500): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error), maxLength);
}

export function redactToolAuditInput(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (depth > 6) return '[truncated]';
  if (typeof value === 'string') return redactSensitiveText(value, 1_000);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((entry) => redactToolAuditInput(entry, depth + 1));
  }
  if (typeof value !== 'object') return String(value).slice(0, 200);

  const sensitiveContentKeys = new Set([
    'prompt',
    'text',
    'body',
    'content',
    'evidence',
    'code',
    'userText',
    'assistantText'
  ]);
  const secretKeys = new Set(['contextId', 'sessionKey', 'apiKey', 'token', 'authorization']);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 100)
      .map(([key, entry]) => {
        if (secretKeys.has(key)) return [key, '[secret redacted]'];
        if (sensitiveContentKeys.has(key) && typeof entry === 'string') {
          return [key, `[content redacted:${entry.length} chars]`];
        }
        return [key.slice(0, 100), redactToolAuditInput(entry, depth + 1)];
      })
  );
}

export function sanitizeLogObject(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > 6) return '[truncated]';
  if (value instanceof Error) return { name: value.name, message: safeErrorSummary(value) };
  if (typeof value === 'string') return redactSensitiveText(value, 2_000);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((entry) => sanitizeLogObject(entry, depth + 1));
  }
  if (typeof value !== 'object') return String(value).slice(0, 500);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 100)
      .map(([key, entry]) => [key, sanitizeLogObject(entry, depth + 1)])
  );
}
