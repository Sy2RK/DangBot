import { describe, expect, it } from 'vitest';
import {
  redactSensitiveText,
  redactToolAuditInput,
  safeErrorSummary
} from '../src/utils/redaction.js';

describe('log and audit redaction', () => {
  it('removes secrets and host paths from errors', () => {
    const fakeApiKey = ['sk', 'example123456789'].join('-');
    const source =
      `Bearer abc-secret ${fakeApiKey} /Users/person/private.txt contextId=opaque-capability`;
    const result = safeErrorSummary(new Error(source));
    expect(result).not.toContain('abc-secret');
    expect(result).not.toContain('sk-example');
    expect(result).not.toContain('/Users/person');
    expect(result).not.toContain('opaque-capability');
    expect(redactSensitiveText(source)).toContain('[host path redacted]');
  });

  it('stores only structural tool input metadata', () => {
    const result = redactToolAuditInput({
      prompt: 'private full prompt',
      code: 'return secret;',
      attachmentId: 'att_12345678',
      nested: { evidence: 'verbatim user text' }
    });
    expect(JSON.stringify(result)).toContain('att_12345678');
    expect(JSON.stringify(result)).not.toContain('private full prompt');
    expect(JSON.stringify(result)).not.toContain('return secret');
    expect(JSON.stringify(result)).not.toContain('verbatim user text');
  });
});
