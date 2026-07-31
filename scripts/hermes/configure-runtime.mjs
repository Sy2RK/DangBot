#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runtimeRoot = path.join(projectRoot, '.runtime', 'hermes');
const backupRoot = path.join(runtimeRoot, 'backups');
const serviceEnvPath = path.join(runtimeRoot, 'service.env');
const localConfigPath = path.join(projectRoot, 'config', 'local.yaml');
const backend = readBackend(process.argv);

const deepseekApiKey = (
  process.env.DANGBOT_DEEPSEEK_API_KEY?.trim() || (await readSecret('DangBot DeepSeek API key: '))
).trim();
if (deepseekApiKey.length < 16 || /[\r\n]/u.test(deepseekApiKey)) {
  throw new Error('DeepSeek API key is missing or invalid.');
}

await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
await mkdir(backupRoot, { recursive: true, mode: 0o700 });

const existingServiceEnv = await readEnvIfExists(serviceEnvPath);
const localConfig = await readYamlIfExists(localConfigPath);
const apiServerKey = keepOrGenerate(existingServiceEnv.API_SERVER_KEY, 32);
const mcpApiKey = keepOrGenerate(existingServiceEnv.DANGBOT_MCP_API_KEY, 32);
const sessionSecret = keepOrGenerate(localConfig.agent?.hermes?.sessionSecret, 32);

await backupIfExists(serviceEnvPath, 'service.env');
await backupIfExists(localConfigPath, 'local.yaml');

const serviceEnv = [
  '# DangBot-only Hermes credentials. Never copy values from ~/.hermes.',
  `DEEPSEEK_API_KEY=${deepseekApiKey}`,
  `API_SERVER_KEY=${apiServerKey}`,
  `DANGBOT_MCP_API_KEY=${mcpApiKey}`,
  '',
  'API_SERVER_ENABLED=true',
  'API_SERVER_HOST=127.0.0.1',
  'API_SERVER_PORT=18642',
  'API_SERVER_MODEL_NAME=deepseek-v4-flash',
  ''
].join('\n');
await writeOwnerOnly(serviceEnvPath, serviceEnv);

localConfig.agent = {
  ...(localConfig.agent ?? {}),
  backend,
  hermes: {
    ...(localConfig.agent?.hermes ?? {}),
    baseURL: 'http://127.0.0.1:18642',
    apiKey: apiServerKey,
    sessionSecret,
    model: 'deepseek-v4-flash',
    maxConcurrentRuns: 2
  },
  mcp: {
    ...(localConfig.agent?.mcp ?? {}),
    enabled: true,
    host: '127.0.0.1',
    port: 18643,
    apiKey: mcpApiKey
  }
};
await writeOwnerOnly(localConfigPath, YAML.stringify(localConfig));

process.stdout.write(
  [
    'Configured the isolated DangBot Hermes runtime.',
    `Backend: ${backend}`,
    'Planner model: deepseek-v4-flash',
    'Qwen/OpenRouter configuration: preserved',
    'Credential values: not printed',
    ''
  ].join('\n')
);

function readBackend(args) {
  const index = args.indexOf('--backend');
  const value = index >= 0 ? args[index + 1] : 'legacy';
  if (value !== 'legacy' && value !== 'hermes') {
    throw new Error('--backend must be legacy or hermes.');
  }
  return value;
}

function keepOrGenerate(value, minimumLength) {
  const current = typeof value === 'string' ? value.trim() : '';
  return current.length >= minimumLength ? current : randomBytes(32).toString('base64url');
}

async function readSecret(prompt) {
  if (!process.stdin.isTTY) {
    let input = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) input += chunk;
    return input;
  }

  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  try {
    return await new Promise((resolve, reject) => {
      let value = '';
      const onData = (chunk) => {
        for (const character of chunk) {
          if (character === '\u0003') {
            reject(new Error('Configuration cancelled.'));
            return;
          }
          if (character === '\r' || character === '\n') {
            process.stdout.write('\n');
            resolve(value);
            return;
          }
          if (character === '\u007f' || character === '\b') {
            value = value.slice(0, -1);
            continue;
          }
          value += character;
        }
      };
      process.stdin.once('error', reject);
      process.stdin.on('data', onData);
    });
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

async function readYamlIfExists(filePath) {
  try {
    return YAML.parse(await readFile(filePath, 'utf8')) ?? {};
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

async function readEnvIfExists(filePath) {
  try {
    const output = {};
    for (const rawLine of (await readFile(filePath, 'utf8')).split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const index = line.indexOf('=');
      if (index > 0) output[line.slice(0, index).trim()] = line.slice(index + 1).trim();
    }
    return output;
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

async function writeOwnerOnly(filePath, content) {
  await writeFile(filePath, content, { mode: 0o600 });
  await chmod(filePath, 0o600);
}

async function backupIfExists(sourcePath, name) {
  try {
    await stat(sourcePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const targetPath = path.join(backupRoot, `${name}.${stamp}.bak`);
  await copyFile(sourcePath, targetPath);
  await chmod(targetPath, 0o600);
}
