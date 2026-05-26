# DangBot

DangBot is a TypeScript MVP for a WeChat group agent bot. It uses Wechaty as a replaceable WeChat adapter, SQLite for local persistence, and an OpenAI-compatible API for text, image, and video understanding.

## Quick start

```bash
pnpm install
cp config/local.yaml.example config/local.yaml
pnpm dev
```

Fill `config/local.yaml` before running against a real WeChat account. The bot only serves authorized rooms. A room can be enabled directly in config; if no admins are configured, DangBot runs in adminless mode.

Sensitive local files are ignored by git: `config/local.yaml`, `data/`, `logs/`, and Wechaty memory-card files.

## Commands in a WeChat group

All commands must mention the bot, for example `@DangBot 状态`.

- `状态`: show bot status.
- `清空上下文`: clear the caller's context.
- `记住 ...`: add a persistent memory for the caller in this room.
- `全局记住 ...`: add a persistent global memory used for all callers.
- `我的记忆` / `全局记忆`: show persistent memories.
- `清空我的记忆` / `清空全局记忆`: clear persistent memories.
- Any other mentioned text is handled as a normal agent request.

## Memory

- Short-term personal context keeps the latest 32 user/assistant messages.
- Short-term room context keeps the latest 160 public room messages for summaries.
- When a personal context reaches the limit, DangBot quietly consolidates it into persistent personal memory.
- If a personal conversation is idle for one hour, DangBot quietly consolidates it into persistent personal memory.
- Global persistent memory is refreshed once per day at 00:00 Beijing time.

Manual memories are stored separately from automatic summaries, so explicit `记住 ...` entries are not overwritten by the background consolidation job.

## Validation

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## Important notes

- This MVP does not add friends, create rooms, invite members, or automatically join rooms.
- Different Wechaty puppet providers have different reliability and platform constraints. Keep the adapter boundary intact when switching providers.
- `config/local.yaml`, `data/`, `logs/`, and `*.memory-card.json` are intentionally ignored by git.
