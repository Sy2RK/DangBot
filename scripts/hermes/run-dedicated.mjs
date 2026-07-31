#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runtimeRoot = path.join(projectRoot, '.runtime', 'hermes');
const home = path.join(runtimeRoot, 'home');
const env = {
  ...(await readEnv(path.join(runtimeRoot, 'browser.env'), false)),
  ...(await readEnv(path.join(runtimeRoot, 'service.env'), true))
};
if (!env.DEEPSEEK_API_KEY) {
  throw new Error('DEEPSEEK_API_KEY is required in .runtime/hermes/service.env');
}
if ((env.API_SERVER_KEY?.length ?? 0) < 16) {
  throw new Error('API_SERVER_KEY must contain at least 16 characters');
}
if ((env.DANGBOT_MCP_API_KEY?.length ?? 0) < 32) {
  throw new Error('DANGBOT_MCP_API_KEY must contain at least 32 characters');
}

const python = path.join(
  runtimeRoot,
  'venv',
  process.platform === 'win32' ? path.join('Scripts', 'python.exe') : path.join('bin', 'python')
);
const browserBin = path.join(
  runtimeRoot,
  'node',
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'agent-browser.cmd' : 'agent-browser'
);
const child = spawn(
  python,
  // --force only bypasses Hermes' broad "some launchd gateway exists" guard.
  // Unlike --replace, it never stops or replaces another process. Isolation is
  // provided by the dedicated HERMES_HOME and non-overlapping loopback ports.
  ['-m', 'hermes_cli.main', 'gateway', 'run', '--force'],
  {
    cwd: home,
    stdio: 'inherit',
    env: {
      ...process.env,
      ...env,
      HERMES_HOME: home,
      AGENT_BROWSER_PROFILE: '',
      AGENT_BROWSER_STATE: '',
      AGENT_BROWSER_EXTENSIONS: '',
      AGENT_BROWSER_AUTO_CONNECT: 'false',
      AGENT_BROWSER_CDP: '',
      AGENT_BROWSER_CONFIG: '',
      AGENT_BROWSER_HEADED: 'false',
      AGENT_BROWSER_DOWNLOAD_PATH: path.join(runtimeRoot, 'browser-downloads'),
      PATH: [path.dirname(browserBin), process.env.PATH ?? ''].filter(Boolean).join(path.delimiter)
    }
  }
);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => child.kill(signal));
}
child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});

async function readEnv(filePath, required) {
  let content;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (error) {
    if (
      !required &&
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return {};
    }
    throw error;
  }
  const values = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    const value = line
      .slice(index + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');
    values[key] = value;
  }
  return values;
}
