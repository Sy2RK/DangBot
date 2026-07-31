#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  throw new Error(
    'launchd installer is macOS-only. Run scripts/hermes/run-dedicated.mjs under your platform service manager.'
  );
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const label = 'com.sy2rk.dangbot-hermes';
const launchAgents = path.join(os.homedir(), 'Library', 'LaunchAgents');
const plistPath = path.join(launchAgents, `${label}.plist`);
const runtimeRoot = path.join(projectRoot, '.runtime', 'hermes');
const runtimePython = path.join(runtimeRoot, 'venv', 'bin', 'python');
await stat(runtimePython).catch(() => {
  throw new Error('Dedicated Hermes runtime is missing. Run pnpm hermes:bootstrap first.');
});
const serviceEnv = await readEnv(path.join(runtimeRoot, 'service.env'));
if (!serviceEnv.DEEPSEEK_API_KEY) throw new Error('Dedicated DEEPSEEK_API_KEY is not configured.');
if ((serviceEnv.API_SERVER_KEY?.length ?? 0) < 16) {
  throw new Error('Dedicated API_SERVER_KEY must contain at least 16 characters.');
}
if ((serviceEnv.DANGBOT_MCP_API_KEY?.length ?? 0) < 32) {
  throw new Error('Dedicated DANGBOT_MCP_API_KEY must contain at least 32 characters.');
}
await mkdir(launchAgents, { recursive: true });

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
    <string>${escapeXml(process.execPath)}</string>
    <string>${escapeXml(path.join(projectRoot, 'scripts', 'hermes', 'run-dedicated.mjs'))}</string>
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(projectRoot)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${escapeXml(path.join(runtimeRoot, 'home', 'logs', 'service.log'))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(path.join(runtimeRoot, 'home', 'logs', 'service.error.log'))}</string>
</dict></plist>\n`;
await writeFile(plistPath, plist, { mode: 0o600 });
await chmod(plistPath, 0o600);

const domain = `gui/${process.getuid()}`;
spawnSync('launchctl', ['bootout', domain, plistPath], { stdio: 'ignore' });
const result = spawnSync('launchctl', ['bootstrap', domain, plistPath], { stdio: 'inherit' });
if (result.status !== 0) throw new Error(`Failed to bootstrap ${label}`);
process.stdout.write(`Installed isolated service ${label} at ${plistPath}\n`);

function escapeXml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

async function readEnv(filePath) {
  const content = await readFile(filePath, 'utf8');
  const values = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    values[line.slice(0, index).trim()] = line
      .slice(index + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}
