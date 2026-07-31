import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import pino from 'pino';
import { loadConfig } from '../../src/config.js';
import { FileService } from '../../src/services/files/fileService.js';
import { ArtifactBroker } from '../../src/services/artifacts/artifactBroker.js';
import { HermesBackendClient } from '../../src/services/hermes/hermesBackendClient.js';
import { OpenAICompatibleClient } from '../../src/services/llm/openaiCompatibleClient.js';
import { DangBotMcpServer } from '../../src/services/mcp/dangbotMcpServer.js';
import { PortableCodeSandbox } from '../../src/services/sandbox/portableCodeSandbox.js';
import { AppDatabase } from '../../src/storage/database.js';

const projectRoot = process.cwd();
const runtimeRoot = path.join(projectRoot, '.runtime', 'hermes');
const hermesHome = path.join(runtimeRoot, 'home');
const python = path.join(
  runtimeRoot,
  'venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
);
const apiKey = 'dangbot-offline-api-key-32-characters';
const mcpKey = 'dangbot-offline-mcp-key-32-characters';
const sessionSecret = 'dangbot-offline-session-secret-at-least-32-characters';
const providerPort = 18_644;
const apiPort = 18_642;
const mcpPort = 18_643;
const logger = pino({ level: 'silent' });
const observedToolNames = new Set<string>();
let gateway: ChildProcess | undefined;

const config = await loadConfig();
config.agent.backend = 'legacy';
config.agent.mcp = {
  ...config.agent.mcp,
  enabled: true,
  host: '127.0.0.1',
  port: mcpPort,
  apiKey: mcpKey
};
config.storage.outputsDir = path.join(runtimeRoot, 'preflight-outputs');
config.llm.apiKey = '';
config.auth.rooms = [{ id: 'offline-room', topic: 'offline', enabled: true, admins: ['admin'] }];
await mkdir(config.storage.outputsDir, { recursive: true });

const db = AppDatabase.memory();
db.seedConfig(config);
const llm = new OpenAICompatibleClient(config.llm, config.storage.outputsDir, 'offline preflight');
const mcp = new DangBotMcpServer(
  config,
  db,
  llm,
  new FileService(config),
  new ArtifactBroker(config, db),
  new PortableCodeSandbox(config.agent.sandbox),
  logger,
  'offline preflight'
);
const provider = createServer((request, response) => {
  void handleProviderRequest(request, response).catch((error) => {
    response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'mock_error' }));
  });
});

try {
  await mcp.start();
  await listen(provider, providerPort);
  gateway = startGateway();
  await waitForHealth();

  const client = new HermesBackendClient({
    baseURL: `http://127.0.0.1:${apiPort}`,
    apiKey,
    sessionSecret,
    model: 'deepseek-v4-flash',
    requestTimeoutMs: 60_000,
    pollIntervalMs: 100,
    maxConcurrentRuns: 2
  });
  const identity = client.sessionIdentity('offline-room', 'offline-user');
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
      DEEPSEEK_API_KEY: 'offline-provider-key',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${providerPort}/v1`,
      API_SERVER_KEY: apiKey,
      DANGBOT_MCP_API_KEY: mcpKey,
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
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-4_000);
  });
  child.once('exit', (code) => {
    if (code && code !== 0) process.stderr.write(`Offline Hermes exited ${code}: ${stderr}\n`);
  });
  return child;
}

function assertToolAllowlist(names: Set<string>): void {
  if (names.size === 0) throw new Error('Hermes did not expose any tools to the planner.');
  const forbidden =
    /terminal|execute_code|read_file|write_file|patch|computer|memory|cron|delegate|skill|homeassistant/i;
  const rejected = [...names].filter((name) => forbidden.test(name));
  if (rejected.length > 0)
    throw new Error(`Forbidden Hermes tools exposed: ${rejected.join(', ')}`);
  const unexpected = [...names].filter(
    (name) => !name.startsWith('web_') && !name.startsWith('browser_') && !name.includes('dangbot')
  );
  if (unexpected.length > 0)
    throw new Error(`Unexpected Hermes tools exposed: ${unexpected.join(', ')}`);
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
