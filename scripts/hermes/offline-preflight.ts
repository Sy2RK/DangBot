import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import pino from 'pino';
import { loadConfig } from '../../src/config.js';
import { FileService } from '../../src/services/files/fileService.js';
import { ArtifactBroker } from '../../src/services/artifacts/artifactBroker.js';
import { HermesBackendClient } from '../../src/services/hermes/hermesBackendClient.js';
import { DashScopeMediaClient } from '../../src/services/llm/dashScopeClient.js';
import { DangBotMcpServer } from '../../src/services/mcp/dangbotMcpServer.js';
import { PortableCodeSandbox } from '../../src/services/sandbox/portableCodeSandbox.js';
import { AppDatabase } from '../../src/storage/database.js';

const projectRoot = process.cwd();
const runtimeRoot = path.join(projectRoot, '.runtime', 'hermes');
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'dangbot-hermes-preflight-'));
const hermesHome = path.join(temporaryRoot, 'home');
const python = path.join(
  runtimeRoot,
  'venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
);
const apiKey = 'dangbot-offline-api-key-32-characters';
const mcpKey = 'dangbot-offline-mcp-key-32-characters';
const memoryKey = 'dangbot-offline-memory-key-32-characters';
const sessionSecret = 'dangbot-offline-session-secret-at-least-32-characters';
const reservedPorts = await reserveLoopbackPorts(3);
const providerPort = reservedPorts[0]!;
const apiPort = reservedPorts[1]!;
const mcpPort = reservedPorts[2]!;
const logger = pino({ level: process.env.DANGBOT_PREFLIGHT_DEBUG === '1' ? 'debug' : 'silent' });
const observedToolNames = new Set<string>();
let gateway: ChildProcess | undefined;
let gatewayStderr = '';

await prepareTemporaryHermesHome();

const config = await loadConfig();
config.agent.mcp = {
  ...config.agent.mcp,
  enabled: true,
  host: '127.0.0.1',
  port: mcpPort,
  apiKey: mcpKey
};
config.agent.memoryBridge = {
  baseURL: `http://127.0.0.1:${mcpPort}`,
  apiKey: memoryKey
};
config.storage.outputsDir = path.join(temporaryRoot, 'outputs');
config.media.apiKey = '';
config.auth.rooms = [{ id: 'offline-room', topic: 'offline', enabled: true, admins: ['admin'] }];
await mkdir(config.storage.outputsDir, { recursive: true });

const db = AppDatabase.memory();
db.seedConfig(config);
const media = new DashScopeMediaClient(config.media, config.storage.outputsDir);
const mcp = new DangBotMcpServer(
  config,
  db,
  media,
  new FileService(config),
  new ArtifactBroker(config, db),
  new PortableCodeSandbox(config.agent.sandbox),
  logger
);
const provider = createServer((request, response) => {
  void handleProviderRequest(request, response).catch((error) => {
    response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'mock_error' }));
  });
});

try {
  await mcp.start();
  await mcp.assertReady();
  await probePythonMcp();
  await listen(provider, providerPort);
  gateway = startGateway();
  await waitForHealth();

  const client = new HermesBackendClient({
    baseURL: `http://127.0.0.1:${apiPort}`,
    apiKey,
    sessionSecret,
    // The offline gateway intentionally combines a temporary HERMES_HOME with
    // the project venv, so production PID/runtime identity matching is covered
    // by unit tests and the live dedicated preflight instead.
    identityFile: '',
    model: 'deepseek-v4-flash',
    requestTimeoutMs: 60_000,
    pollIntervalMs: 100,
    maxConcurrentRuns: 2
  });
  await client.assertReady(AbortSignal.timeout(10_000));
  const identity = client.sessionIdentity('offline-room', 'offline-user', 0);
  db.upsertHermesSession({
    sessionKeyHash: identity.sessionKeyHash,
    roomId: 'offline-room',
    userId: 'offline-user',
    epoch: 0,
    purpose: 'interactive',
    hermesSessionId: identity.sessionId
  });
  const result = await client.run(
    {
      input: 'Return the offline preflight response.',
      instructions: 'Do not call a tool. Return the provider response.',
      sessionId: identity.sessionId,
      sessionKey: identity.sessionKey
    },
    new AbortController().signal
  );
  if (result.output.trim() !== 'offline preflight ok') {
    throw new Error(`Unexpected Hermes output: ${result.output.slice(0, 200)}`);
  }
  assertToolAllowlist(observedToolNames);
  process.stdout.write(
    `Offline Hermes preflight passed: model=deepseek-v4-flash tools=${observedToolNames.size} output=ok\n`
  );
} finally {
  if (gateway && gateway.exitCode === null) {
    gateway.kill('SIGINT');
    await waitForExit(gateway, 10_000);
  }
  await mcp.stop();
  await close(provider);
  db.close();
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function handleProviderRequest(
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  if (request.method === 'GET' && request.url === '/v1/models') {
    return json(response, { object: 'list', data: [{ id: 'deepseek-v4-flash', object: 'model' }] });
  }
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404);
    response.end();
    return;
  }
  const body = JSON.parse(await readBody(request)) as {
    model?: string;
    stream?: boolean;
    tools?: Array<{ function?: { name?: string } }>;
  };
  if (body.model !== 'deepseek-v4-flash')
    throw new Error(`Unexpected planner model: ${body.model}`);
  for (const tool of body.tools ?? []) {
    const name = tool.function?.name;
    if (name) observedToolNames.add(name);
  }
  if (body.stream) {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    response.write(`data: ${JSON.stringify(completionChunk({ role: 'assistant' }))}\n\n`);
    response.write(
      `data: ${JSON.stringify(completionChunk({ content: 'offline preflight ok' }))}\n\n`
    );
    response.write(`data: ${JSON.stringify(completionChunk({}, 'stop'))}\n\n`);
    response.end('data: [DONE]\n\n');
    return;
  }
  json(response, {
    id: 'chatcmpl-dangbot-preflight',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1_000),
    model: 'deepseek-v4-flash',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'offline preflight ok' },
        finish_reason: 'stop'
      }
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  });
}

function completionChunk(delta: Record<string, string>, finishReason: string | null = null) {
  return {
    id: 'chatcmpl-dangbot-preflight',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1_000),
    model: 'deepseek-v4-flash',
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  };
}

function startGateway(): ChildProcess {
  const browserEnv = readSimpleEnv(path.join(runtimeRoot, 'browser.env'));
  const child = spawn(python, ['-m', 'hermes_cli.main', 'gateway', 'run', '--force'], {
    cwd: hermesHome,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...browserEnv,
      HERMES_HOME: hermesHome,
      HERMES_PLUGINS_DEBUG: '1',
      NO_PROXY: loopbackNoProxy(process.env.NO_PROXY),
      no_proxy: loopbackNoProxy(process.env.no_proxy),
      DEEPSEEK_API_KEY: 'offline-provider-key',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${providerPort}/v1`,
      API_SERVER_KEY: apiKey,
      DANGBOT_MCP_API_KEY: mcpKey,
      DANGBOT_MEMORY_BRIDGE_API_KEY: memoryKey,
      DANGBOT_MEMORY_BRIDGE_URL: `http://127.0.0.1:${mcpPort}`,
      API_SERVER_ENABLED: 'true',
      API_SERVER_HOST: '127.0.0.1',
      API_SERVER_PORT: String(apiPort),
      API_SERVER_MODEL_NAME: 'deepseek-v4-flash',
      AGENT_BROWSER_PROFILE: '',
      AGENT_BROWSER_STATE: '',
      AGENT_BROWSER_EXTENSIONS: '',
      AGENT_BROWSER_AUTO_CONNECT: 'false'
    }
  });
  child.stderr?.on('data', (chunk) => {
    gatewayStderr = `${gatewayStderr}${String(chunk)}`.slice(-12_000);
  });
  child.once('exit', (code) => {
    if (code && code !== 0)
      process.stderr.write(`Offline Hermes exited ${code}: ${gatewayStderr}\n`);
  });
  return child;
}

function assertToolAllowlist(names: Set<string>): void {
  if (names.size === 0) throw new Error('Hermes did not expose any tools to the planner.');
  const normalized = new Set(
    [...names].map((name) => name.replace(/^mcp__dangbot__/u, ''))
  );
  const required = [
    'web_search',
    'dangbot_attachment_list',
    'dangbot_file_extract',
    'dangbot_image_analyze',
    'dangbot_video_analyze',
    'dangbot_image_generate',
    'dangbot_video_generate',
    'dangbot_tts_generate',
    'dangbot_document_render',
    'dangbot_room_context',
    'dangbot_javascript_execute',
    'dangbot_automation_create',
    'dangbot_automation_list',
    'dangbot_automation_update',
    'dangbot_automation_delete',
    'dangbot_memory_recall',
    'dangbot_memory_propose',
    'dangbot_memory_feedback'
  ];
  const missing = required.filter((name) => !normalized.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Required DangBot tools missing: ${missing.join(', ')}; observed=${[...names].sort().join(', ')}`
        + `; gateway=${gatewayStderr.slice(-6_000)}`
    );
  }
  const forbidden =
    /terminal|execute_code|read_file|write_file|patch|computer|cron|delegate|skill|homeassistant/i;
  const rejected = [...normalized].filter(
    (name) => forbidden.test(name) && !name.startsWith('dangbot_memory_')
  );
  if (rejected.length > 0)
    throw new Error(`Forbidden Hermes tools exposed: ${rejected.join(', ')}`);
  const unexpected = [...normalized].filter(
    (name) =>
      !name.startsWith('web_') && !name.startsWith('browser_') && !name.startsWith('dangbot_')
  );
  if (unexpected.length > 0)
    throw new Error(`Unexpected Hermes tools exposed: ${unexpected.join(', ')}`);
}

async function prepareTemporaryHermesHome(): Promise<void> {
  await Promise.all([
    mkdir(path.join(hermesHome, 'logs'), { recursive: true }),
    mkdir(path.join(hermesHome, 'sessions'), { recursive: true }),
    mkdir(path.join(hermesHome, 'memories'), { recursive: true }),
    mkdir(path.join(hermesHome, 'plugins'), { recursive: true })
  ]);
  const trackedConfig = await readFile(
    path.join(projectRoot, 'config', 'hermes', 'dedicated.yaml'),
    'utf8'
  );
  await writeFile(
    path.join(hermesHome, 'config.yaml'),
    trackedConfig.replace('http://127.0.0.1:18643/mcp', `http://127.0.0.1:${mcpPort}/mcp`),
    { mode: 0o600 }
  );
  await cp(path.join(projectRoot, 'config', 'hermes', 'plugins'), path.join(hermesHome, 'plugins'), {
    recursive: true
  });
}

async function probePythonMcp(): Promise<void> {
  const source = `
import asyncio, os
import httpx
from mcp import ClientSession
try:
    from mcp.client.streamable_http import streamable_http_client as http_client
except ImportError:
    from mcp.client.streamable_http import streamablehttp_client as http_client

async def main():
    async with httpx.AsyncClient(
        headers={"Authorization": "Bearer " + os.environ["DANGBOT_PREFLIGHT_MCP_KEY"]}
    ) as client:
        async with http_client(
            os.environ["DANGBOT_PREFLIGHT_MCP_URL"], http_client=client
        ) as streams:
            async with ClientSession(streams[0], streams[1]) as session:
                await session.initialize()
                result = await session.list_tools()
                print(len(result.tools))

asyncio.run(main())
`;
  const child = spawn(python, ['-c', source], {
    cwd: temporaryRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DANGBOT_PREFLIGHT_MCP_URL: `http://127.0.0.1:${mcpPort}/mcp`,
      DANGBOT_PREFLIGHT_MCP_KEY: mcpKey,
      NO_PROXY: loopbackNoProxy(process.env.NO_PROXY),
      no_proxy: loopbackNoProxy(process.env.no_proxy)
    }
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr?.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
  const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
  if (code !== 0 || Number(Buffer.concat(stdout).toString('utf8').trim()) !== 17) {
    throw new Error(
      `Python MCP compatibility probe failed (${code}): ${Buffer.concat(stderr).toString('utf8').slice(-4_000)}`
    );
  }
}

function loopbackNoProxy(current: string | undefined): string {
  return Array.from(
    new Set([...(current ?? '').split(',').map((entry) => entry.trim()).filter(Boolean), '127.0.0.1', 'localhost', '::1'])
  ).join(',');
}

async function reserveLoopbackPorts(count: number): Promise<number[]> {
  const servers = Array.from({ length: count }, () => createServer());
  try {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
          })
      )
    );
    return servers.map((server) => {
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Failed to reserve a loopback port.');
      return address.port;
    });
  } finally {
    await Promise.all(servers.map((server) => close(server)));
  }
}

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (gateway?.exitCode !== null)
      throw new Error(`Dedicated Hermes exited before health check (${gateway?.exitCode}).`);
    try {
      const response = await fetch(`http://127.0.0.1:${apiPort}/health/detailed`, {
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      if (response.ok) return;
    } catch {
      // Gateway is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for dedicated Hermes health.');
}

function listen(server: ReturnType<typeof createServer>, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

function readSimpleEnv(filePath: string): Record<string, string> {
  try {
    const text = readFileSync(filePath, 'utf8');
    return Object.fromEntries(
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#') && line.includes('='))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
    );
  } catch {
    return {};
  }
}
