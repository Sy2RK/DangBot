# DangBot

DangBot is a TypeScript MVP for a WeChat group agent bot. It uses Wechaty as a replaceable WeChat adapter, SQLite for local persistence, and an OpenAI-compatible API for text, image, and video understanding plus image/video generation.

## Quick start

```bash
pnpm install
cp config/local.yaml.example config/local.yaml
pnpm dev
```

Fill `config/local.yaml` before running against a real WeChat account. The bot only serves authorized rooms. Prefer stable room IDs in config; topic-only binding is disabled by default because group names are not unique. A room can be enabled directly in config; if no admins are configured, DangBot runs in adminless mode.

Sensitive local files are ignored by git: `config/local.yaml`, `data/`, `logs/`, and Wechaty memory-card files.

## Commands in a WeChat group

All commands must mention the bot, for example `@DangBot 状态`.

- `状态`: show bot status.
- `清空上下文`: clear the caller's context.
- `记住 ...`: add a persistent memory for the caller in this room.
- `全局记住 ...`: add a persistent global memory used for all callers.
- `我的记忆` / `全局记忆`: show persistent memories.
- `清空我的记忆` / `清空全局记忆`: clear persistent memories.
- `提醒我 10分钟后 喝水` / `提醒我每天 09:00 喝水`: create a reminder. Creating, pausing, resuming, and deleting automations require a group admin or system admin.
- `定时 每天 09:00 总结群聊` / `自动化 每30分钟 联网搜索 Qwen 最新消息`: create a recurring scheduled agent request.
- `自动化列表`: list this room's automations.
- `暂停 auto_xxx` / `恢复 auto_xxx` / `删除 auto_xxx`: manage an automation by ID.
- `生成图片 ...` / `画一张 ...` / `出图 ...`: generate an image. The default OpenRouter model is `bytedance-seed/seedream-4.5`.
- `生成视频 ...` / `做个视频 ...` / `出视频 ...`: generate a short video. The default OpenRouter model is `bytedance/seedance-2.0`. Prompts such as `5s`, `10 秒`, or `五秒` are parsed and passed as the requested duration.
- Send an image and ask `把这张图动起来`: generate an image-to-video result from that image.
- `联网搜索 ...` / `帮我查一下 ...`: search the web, then answer with source URLs. Time-sensitive external topics such as weather, news, prices, schedules, and model releases can also trigger search when the wording implies current information. Casual phrases like `今天午饭吃什么` stay as normal chat.
- Any other mentioned text is handled as a normal agent request.

## Files And Media

- Supported file/media types: `txt`, `md`, `csv`, `xlsx`, `docx`, `pdf`, `png`, `jpg`, `jpeg`, `webp`, `mp4`, `mpeg`, `mpg`, `mov`, `webm`, and `m4v`.
- Images sent as regular WeChat file attachments are still classified as images by extension, so follow-up requests like `分析刚才的图` or `把这张图动起来` can use them.
- Attachments are cached locally for a limited time and are scoped by room and user.

## Memory

- Short-term personal context keeps the latest 32 user/assistant messages.
- Short-term room context keeps the latest 160 public room messages, including normal group chat, mentioned requests, and DangBot task replies.
- Normal replies keep personal context isolated, but also receive a small recent room-context window so the bot can follow shared group references.
- When a personal context reaches the limit, DangBot quietly consolidates it into persistent personal memory.
- If a personal conversation is idle for one hour, DangBot quietly consolidates it into persistent personal memory.
- Global persistent memory is refreshed once per day at 00:00 Beijing time.

Manual memories are stored separately from automatic summaries, so explicit `记住 ...` entries are not overwritten by the background consolidation job.

## Tools, Policy, And Automations

- Built-in tool calls such as web search, file analysis, image/video analysis, and image/video generation are registered in a tool registry and recorded in SQLite.
- `tools.policy.denyTools` can disable specific tools globally, for example `web.search`; `roomToolOverrides` can scope allow/deny rules to a room.
- High-risk tools, including video generation, require approval when an approver is configured. Adminless mode keeps the earlier no-approval behavior.
- Automations support one-time reminders, daily schedules, weekly schedules, and fixed intervals. Due automations are dispatched after the Wechaty adapter starts and reuse the same task queue and tool policy as normal requests.

## Validation

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## Important notes

- This MVP does not add friends, create rooms, invite members, or automatically join rooms.
- Video generation is asynchronous and may take several minutes. DangBot polls OpenRouter and returns the generated `.mp4` as a file when it is ready.
- Web search uses OpenRouter's web search tool by default when `search.enabled` is true. Brave Search remains available with `search.provider: brave` and `search.braveApiKey`.
- Search prompts include the current Beijing date/time and add a date anchor for time-sensitive queries, so relative phrases such as “today” and “this week” are interpreted against the current Beijing date.
- `pnpm audit --prod` is expected to pass. The project pins safe overrides and small local compatibility shims for legacy transitive packages in the Wechaty/FileBox chains; revisit these shims when upstream packages publish maintained replacements.
- Different Wechaty puppet providers have different reliability and platform constraints. Keep the adapter boundary intact when switching providers.
- `config/local.yaml`, `data/`, `logs/`, and `*.memory-card.json` are intentionally ignored by git.
