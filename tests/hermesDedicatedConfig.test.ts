import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

describe('dedicated Hermes configuration', () => {
  it('keeps a minimal allowlist and disables global memory and host tools', async () => {
    const file = await readFile(path.join(process.cwd(), 'config/hermes/dedicated.yaml'), 'utf8');
    const config = YAML.parse(file) as Record<string, any>;

    expect(config.model).toBe('deepseek-v4-flash');
    expect(config.max_concurrent_sessions).toBe(2);
    expect(config.gateway.api_server.max_concurrent_runs).toBe(2);
    expect(config.platform_toolsets.api_server).toEqual(['web', 'browser', 'dangbot']);
    expect(config.web.backend).toBe('ddgs');
    expect(config.memory).toMatchObject({
      provider: 'dangbot_scoped',
      memory_enabled: false,
      user_profile_enabled: false
    });
    expect(config.agent.disabled_toolsets).toEqual(
      expect.arrayContaining([
        'terminal',
        'file',
        'code_execution',
        'memory',
        'delegation',
        'computer_use',
        'homeassistant'
      ])
    );
    expect(config.mcp_servers.dangbot.url).toBe('http://127.0.0.1:18643/mcp');
    expect(config.mcp_servers.dangbot.tools.include).toContain('dangbot_file_extract');
    expect(config.mcp_servers.dangbot.tools.include).toEqual(
      expect.arrayContaining([
        'dangbot_memory_recall',
        'dangbot_memory_propose',
        'dangbot_memory_feedback'
      ])
    );
    expect(config.mcp_servers.dangbot.tools.include).not.toContain('dangbot_execute_tool');
    expect(config.plugins.enabled).toContain('dangbot_guard');

    const bootstrap = await readFile(
      path.join(process.cwd(), 'scripts/hermes/bootstrap-runtime.mjs'),
      'utf8'
    );
    expect(bootstrap).toContain("'ddgs==9.14.4'");

    const guard = await readFile(
      path.join(process.cwd(), 'config/hermes/plugins/dangbot_guard/__init__.py'),
      'utf8'
    );
    expect(guard).toContain('dangbot_r_');
    expect(guard).toContain('action": "block');
    expect(guard).toContain('action": "approve');
    expect(guard).toContain('tool_name.endswith(f"__{expected}")');

    const provider = await readFile(
      path.join(process.cwd(), 'config/hermes/plugins/dangbot_scoped/__init__.py'),
      'utf8'
    );
    expect(provider).toContain('return []');
    expect(provider).not.toContain('MEMORY.md", "a"');
  });

  it('never uses profile mutation or process replacement in launch scripts', async () => {
    const bootstrap = await readFile(
      path.join(process.cwd(), 'scripts/hermes/bootstrap-runtime.mjs'),
      'utf8'
    );
    const runner = await readFile(
      path.join(process.cwd(), 'scripts/hermes/run-dedicated.mjs'),
      'utf8'
    );

    expect(`${bootstrap}\n${runner}`).not.toMatch(/profile\s+(?:use|clone|update)/);
    expect(runner).not.toContain("'--replace'");
    expect(runner).toContain("'--force'");
    expect(runner).toContain('HERMES_HOME: home');
  });
});
