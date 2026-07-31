import { describe, expect, it } from 'vitest';
import { PortableCodeSandbox } from '../src/services/sandbox/portableCodeSandbox.js';

describe('PortableCodeSandbox', () => {
  it('runs pure JavaScript in WASM and captures bounded output', async () => {
    const sandbox = makeSandbox();
    const result = await sandbox.executeJavaScript(
      'console.log("sum", 2 + 3); return { sum: [1, 2, 3].reduce((a, b) => a + b, 0) };'
    );
    expect(result.value).toEqual({ sum: 6 });
    expect(result.stdout).toContain('sum 5');
  });

  it('does not expose host process, filesystem modules, or network fetch', async () => {
    const sandbox = makeSandbox();
    const result = await sandbox.executeJavaScript(
      'return [typeof process, typeof require, typeof fetch, typeof XMLHttpRequest];'
    );
    expect(result.value).toEqual(['undefined', 'undefined', 'undefined', 'undefined']);
  });

  it('interrupts non-terminating code', async () => {
    const sandbox = makeSandbox(50);
    await expect(sandbox.executeJavaScript('while (true) {}')).rejects.toThrow(
      /时间限制|interrupted/i
    );
  });

  it('honors task cancellation', async () => {
    const sandbox = makeSandbox();
    const controller = new AbortController();
    controller.abort();
    await expect(sandbox.executeJavaScript('while (true) {}', controller.signal)).rejects.toThrow(
      /时间限制|interrupted/i
    );
  });
});

function makeSandbox(maxExecutionMs = 500): PortableCodeSandbox {
  return new PortableCodeSandbox({
    enabled: true,
    maxExecutionMs,
    memoryLimitBytes: 16 * 1024 * 1024,
    maxOutputChars: 2_000
  });
}
