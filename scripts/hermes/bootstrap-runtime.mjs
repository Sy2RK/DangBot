#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runtimeRoot = path.join(projectRoot, '.runtime', 'hermes');
const home = path.join(runtimeRoot, 'home');
const venv = path.join(runtimeRoot, 'venv');
const withBrowser = process.argv.includes('--with-browser');
const downloadBrowser = process.argv.includes('--download-browser');

await mkdir(home, { recursive: true, mode: 0o700 });
await mkdir(path.join(home, 'logs'), { recursive: true, mode: 0o700 });
await mkdir(path.join(home, 'sessions'), { recursive: true, mode: 0o700 });
await mkdir(path.join(home, 'memories'), { recursive: true, mode: 0o700 });

const python = findPython();
if (!(await exists(path.join(venv, pythonBinName())))) {
  run(python.command, [...python.args, '-m', 'venv', venv]);
}

const venvPython = path.join(venv, pythonBinName());
run(venvPython, [
  '-m',
  'pip',
  'install',
  '--disable-pip-version-check',
  '--timeout',
  '180',
  '--retries',
  '10',
  'hermes-agent==0.19.0',
  'aiohttp==3.14.1',
  'mcp>=1.24,<2'
]);

await copyFile(
  path.join(projectRoot, 'config', 'hermes', 'dedicated.yaml'),
  path.join(home, 'config.yaml')
);
await chmod(path.join(home, 'config.yaml'), 0o600);

const envPath = path.join(runtimeRoot, 'service.env');
if (!(await exists(envPath))) {
  await copyFile(path.join(projectRoot, 'config', 'hermes', 'service.env.example'), envPath);
  await chmod(envPath, 0o600);
  process.stdout.write(`Created ${envPath}; fill the three dedicated secrets before starting.\n`);
}

if (withBrowser) {
  const nodePrefix = path.join(runtimeRoot, 'node');
  run(npmCommand(), ['install', '--prefix', nodePrefix, '--save-exact', 'agent-browser@0.26.0']);
  const browserBin = path.join(nodePrefix, 'node_modules', '.bin', executableName('agent-browser'));
  const browserEnvPath = path.join(runtimeRoot, 'browser.env');
  const systemBrowser = downloadBrowser ? undefined : findSystemBrowser();
  if (systemBrowser) {
    await writeFile(
      browserEnvPath,
      `# Executable only; agent-browser still creates a fresh temporary profile.\nAGENT_BROWSER_EXECUTABLE_PATH=${systemBrowser}\n`,
      { mode: 0o600 }
    );
    await chmod(browserEnvPath, 0o600);
    validateBrowser(browserBin, { AGENT_BROWSER_EXECUTABLE_PATH: systemBrowser });
    process.stdout.write(
      `Using installed browser executable with an isolated temporary profile: ${systemBrowser}\n`
    );
  } else {
    run(browserBin, ['install']);
    await unlink(browserEnvPath).catch(() => undefined);
    validateBrowser(browserBin);
  }
}

process.stdout.write(`Dedicated Hermes runtime ready at ${runtimeRoot}\n`);

function findPython() {
  const configured = process.env.DANGBOT_HERMES_PYTHON?.trim();
  const candidates = configured
    ? [{ command: configured, args: [] }]
    : process.platform === 'win32'
      ? [
          { command: 'py', args: ['-3.13'] },
          { command: 'py', args: ['-3.12'] },
          { command: 'py', args: ['-3.11'] },
          { command: 'python', args: [] }
        ]
      : [
          {
            command:
              '/Users/sheny2/.local/share/uv/python/cpython-3.11.15-macos-aarch64-none/bin/python3.11',
            args: []
          },
          { command: 'python3.13', args: [] },
          { command: 'python3.12', args: [] },
          { command: 'python3.11', args: [] }
        ];
  for (const candidate of candidates) {
    const probe = spawnSync(
      candidate.command,
      [...candidate.args, '-c', 'import sys; print(sys.version_info[0], sys.version_info[1])'],
      {
        encoding: 'utf8'
      }
    );
    if (probe.status !== 0) continue;
    const [major, minor] = probe.stdout.trim().split(/\s+/).map(Number);
    if (major === 3 && minor >= 11 && minor < 14) return candidate;
  }
  throw new Error(
    'Python 3.11-3.13 not found. Set DANGBOT_HERMES_PYTHON to an independent Python executable.'
  );
}

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv }
  });
  if (result.status !== 0) throw new Error(`Command failed: ${command}`);
}

function validateBrowser(browserBin, extraEnv = {}) {
  const session = `dangbot-bootstrap-${process.pid}`;
  run(browserBin, ['--session', session, 'open', 'about:blank'], extraEnv);
  try {
    run(browserBin, ['--session', session, 'get', 'url'], extraEnv);
  } finally {
    run(browserBin, ['--session', session, 'close'], extraEnv);
  }
}

function findSystemBrowser() {
  const candidates =
    process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
        ]
      : process.platform === 'win32'
        ? [
            path.join(
              process.env.PROGRAMFILES ?? 'C:\\Program Files',
              'Google',
              'Chrome',
              'Application',
              'chrome.exe'
            ),
            path.join(
              process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)',
              'Google',
              'Chrome',
              'Application',
              'chrome.exe'
            )
          ]
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find(
    (candidate) => spawnSync(candidate, ['--version'], { stdio: 'ignore' }).status === 0
  );
}

function pythonBinName() {
  return process.platform === 'win32'
    ? path.join('Scripts', 'python.exe')
    : path.join('bin', 'python');
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function executableName(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
