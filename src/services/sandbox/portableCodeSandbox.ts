import { getQuickJS, type QuickJSContext, type QuickJSRuntime } from 'quickjs-emscripten';
import type { AppConfig } from '../../types.js';

export interface SandboxExecutionResult {
  value: unknown;
  stdout: string;
  truncated: boolean;
}

export class PortableCodeSandbox {
  constructor(private readonly config: AppConfig['agent']['sandbox']) {}

  configured(): boolean {
    return this.config.enabled;
  }

  async executeJavaScript(code: string, signal?: AbortSignal): Promise<SandboxExecutionResult> {
    if (!this.config.enabled) throw new Error('便携代码沙箱未启用。');
    if (!code.trim()) throw new Error('代码不能为空。');
    if (Buffer.byteLength(code, 'utf8') > 64 * 1024) throw new Error('代码超过 64 KB 限制。');

    const QuickJS = await getQuickJS();
    const runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(this.config.memoryLimitBytes);
    runtime.setMaxStackSize(
      Math.min(2 * 1024 * 1024, Math.floor(this.config.memoryLimitBytes / 4))
    );
    const deadline = Date.now() + this.config.maxExecutionMs;
    runtime.setInterruptHandler(() => Boolean(signal?.aborted) || Date.now() > deadline);

    const context = runtime.newContext();
    const logs: string[] = [];
    try {
      installConsole(context, logs, this.config.maxOutputChars);
      const wrapped = [
        '"use strict";',
        'delete globalThis.process;',
        'delete globalThis.require;',
        'delete globalThis.fetch;',
        'delete globalThis.XMLHttpRequest;',
        `globalThis.__dangbotResult = (() => {\n${code}\n})();`,
        'JSON.stringify({ value: globalThis.__dangbotResult ?? null })'
      ].join('\n');
      const result = context.evalCode(wrapped, 'dangbot-sandbox.js');
      if (result.error) {
        const dumped = context.dump(result.error);
        result.error.dispose();
        throw new Error(formatSandboxError(dumped));
      }
      const serialized = context.dump(result.value);
      result.value.dispose();
      const parsed = typeof serialized === 'string' ? safeParse(serialized) : { value: serialized };
      const stdout = logs.join('\n');
      return {
        value: isRecord(parsed) && 'value' in parsed ? parsed.value : parsed,
        stdout: stdout.slice(0, this.config.maxOutputChars),
        truncated: stdout.length > this.config.maxOutputChars
      };
    } finally {
      context.dispose();
      disposeRuntime(runtime);
    }
  }
}

function installConsole(context: QuickJSContext, logs: string[], maxChars: number): void {
  const logHandle = context.newFunction('__dangbotLog', (...args) => {
    if (logs.join('\n').length >= maxChars) return context.undefined;
    logs.push(args.map((arg) => formatLogValue(context.dump(arg))).join(' '));
    return context.undefined;
  });
  context.setProp(context.global, '__dangbotLog', logHandle);
  logHandle.dispose();
  const installed = context.evalCode(
    'globalThis.console = Object.freeze({ log: (...args) => __dangbotLog(...args), warn: (...args) => __dangbotLog(...args), error: (...args) => __dangbotLog(...args) });'
  );
  if (installed.error) {
    const dumped = context.dump(installed.error);
    installed.error.dispose();
    throw new Error(formatSandboxError(dumped));
  }
  installed.value.dispose();
}

function disposeRuntime(runtime: QuickJSRuntime): void {
  try {
    runtime.dispose();
  } catch {
    // The runtime may already be torn down after an interrupt or memory limit.
  }
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function formatLogValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatSandboxError(value: unknown): string {
  if (isRecord(value)) {
    const name = typeof value.name === 'string' ? value.name : 'Error';
    const message = typeof value.message === 'string' ? value.message : '代码执行失败';
    if (/interrupted/i.test(message)) return '代码执行超过时间限制。';
    return `${name}: ${message}`;
  }
  return `代码执行失败：${String(value)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
