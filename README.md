# DangBot

DangBot is a TypeScript WeChat group agent bot. Wechaty/wechat4u remains the group transport and policy edge. The agent backend is switchable: `legacy` keeps the original Node loop for emergency rollback, while `hermes` sends all planning and tool orchestration to a dedicated, isolated Hermes Agent and keeps attachments, approval, delivery, scheduling, and scoped memory in DangBot.

## Quick start

```bash
pnpm install
cp config/local.yaml.example config/local.yaml
pnpm dev
```

Fill `config/local.yaml` before running against a real WeChat account. The bot only serves authorized rooms. Prefer a stable `stableId` per real group and put Wechaty runtime room IDs under `id`/`runtimeIds`; topic-only binding is disabled by default because group names are not unique. A room can be enabled directly in config; if no admins are configured, DangBot runs in adminless mode.

Sensitive local files are ignored by git: `config/local.yaml`, `data/`, `logs/`, and Wechaty memory-card files.

## Dedicated Hermes backend

The dedicated instance is pinned to `hermes-agent==0.19.0`, listens on `127.0.0.1:18642`, and talks to the loopback-only DangBot MCP service on `127.0.0.1:18643`. Its complete runtime lives under ignored `.runtime/hermes/`; it never reads or modifies `~/.hermes`, and its launcher does not use Hermes profile commands or `--replace`.

```bash
# Create the isolated Python environment and config.
pnpm hermes:bootstrap

# Isolated, logged-out agent-browser runtime. It may reuse only a locally
# installed browser executable; profiles, cookies and sessions stay temporary.
pnpm hermes:bootstrap:browser

# Optional: download a separate Chrome for Testing binary instead.
pnpm hermes:bootstrap:browser-download

# After filling .runtime/hermes/service.env with dedicated credentials:
pnpm hermes:run
```

Set `DANGBOT_MCP_API_KEY` while DangBot is still on `legacy` to start MCP for offline verification. Only after both health checks and simulated events pass, set `DANGBOT_HERMES_API_KEY`, `DANGBOT_HERMES_SESSION_SECRET`, and `DANGBOT_AGENT_BACKEND=hermes`, then restart DangBot. DeepSeek `deepseek-v4-flash` is always the planner in this mode; Qwen `qwen/qwen3.7-plus` remains the file/image/video understanding model behind DangBot MCP.

There is no container runtime dependency. Safe code execution is pure JavaScript in a bounded QuickJS-WASM runtime with no shell, host filesystem, `process`, `require`, or network API. Browser automation uses the dedicated Hermes browser installation and an ephemeral, logged-out session; it never uses the user's Chrome profile or cookies. See [the Hermes operations runbook](docs/hermes-backend.md) for validation, launchd, cutover, and rollback.

## Commands in a WeChat group

All commands must mention the bot, for example `@DangBot 状态`.

- `状态`: show bot status.
- `/health` / `自检`: run a local self-check and report each capability in DangBot's cat voice.
- `清空上下文`: clear the caller's context.
- `记住 ...`: add a persistent memory for the caller in this room.
- `全局记住 ...`: add a persistent room-shared memory for callers in the current room. The legacy command name remains for compatibility; it never crosses rooms.
- `我的记忆` / `全局记忆`: show persistent memories.
- `清空我的记忆` / `清空全局记忆`: clear persistent memories.
- `提醒我 10分钟后 喝水` / `设置提醒 10分钟后 喝水` / `提醒我每天 09:00 喝水`: create a reminder. Creating, pausing, resuming, and deleting automations require a group admin or system admin when admins are configured; adminless rooms allow normal members to manage them.
- `定时 每天 09:00 总结群聊` / `设置定时任务 每天 09:00 总结群聊` / `自动化 每30分钟 联网搜索 Qwen 最新消息`: create a recurring scheduled agent request.
- `自动化列表`: list this room's automations.
- `暂停第1个` / `恢复第1个` / `删除第1个`: manage an automation by its position in `自动化列表`.
- `生成图片 ...` / `画一张 ...` / `出图 ...`: generate an image. The default OpenRouter model is `bytedance-seed/seedream-4.5`.
- `生成语音：今天也要开心呀` / `朗读：...`: synthesize the requested text with Doubao TTS 2.0 and send the result as an MP3 file. Named works can trigger multiple steps: retrieve the text, extract its exact body, then synthesize only that body.
- `生成视频 ...` / `做个视频 ...` / `出视频 ...`: generate a short video. The default OpenRouter model is `bytedance/seedance-2.0`. Prompts such as `5s`, `10 秒`, or `五秒` are parsed and passed as the requested duration.
- Send an image and ask `把这张图动起来`: generate an image-to-video result from that image.
- `联网搜索 ...` / `帮我查一下 ...`: search the web, then answer with source URLs. Time-sensitive external topics such as weather, news, prices, schedules, and model releases can also trigger search when the wording implies current information. Casual phrases like `今天午饭吃什么` stay as normal chat.
- Any other mentioned text is handled as a normal agent request.

## Files And Media

- Supported file/media types: `txt`, `md`, `csv`, `xlsx`, `docx`, `pdf`, `png`, `jpg`, `jpeg`, `webp`, `mp4`, `mpeg`, `mpg`, `mov`, `webm`, and `m4v`.
- Images sent as regular WeChat file attachments are still classified as images by extension, so follow-up requests like `分析刚才的图` or `把这张图动起来` can use them.
- Attachments are cached locally for a limited time and are scoped by room and user.
- Follow-up requests can bind to the sender's recent valid file. Attachment-backed rewrite and translation tasks read the file instead of treating the request as plain chat.
- Edited `docx`, `txt`, and `md` files are uploaded back in the same file type. Generated DOCX files preserve editable text and paragraph breaks, but complex source styling and embedded objects are not guaranteed to survive.
- Voice generation calls Doubao's `seed-tts-2.0` HTTP streaming API with the configured speaker, joins its base64-encoded MP3 chunks, and sends the resulting `.mp3` through the existing WeChat file path.

## Memory

- `CAPABILITIES.md` is Xiao Dang's local self-capability memory. It is loaded into the system prompt at startup, stays separate from user/global memories, and cannot be cleared by chat commands.
- Every user-facing feature change must update `CAPABILITIES.md` in the same change so the bot can describe what it can and cannot do accurately in its cat voice.
- In `legacy` mode, short-term personal context keeps the latest 32 user/assistant messages.
- Short-term room context keeps the latest 160 public room messages, including normal group chat, mentioned requests, and DangBot task replies.
- Normal replies keep personal context isolated, but also receive a small recent room-context window so the bot can follow shared group references.
- Automatic context consolidation only runs in `legacy` mode. The Hermes backend starts new opaque sessions and only receives memories explicitly saved in the current room/user scope; Hermes global memory is disabled.
- The commands named `全局记住` and `全局记忆` now mean “shared in this room”. Existing legacy rows stored with the old cross-room `*` scope are intentionally not imported into Hermes.

Manual memories are stored separately from automatic summaries, so explicit `记住 ...` entries are not overwritten by the background consolidation job.

## Tools, Policy, And Automations

- Built-in tool calls such as web search, file analysis, image/video analysis, and image/video generation are registered in a tool registry and recorded in SQLite.
- In `legacy` mode, tool-backed requests run through the original bounded Node loop. In `hermes` mode, the Node loop is bypassed: Hermes plans the task and calls only the explicitly allowlisted built-in web/browser tools and DangBot MCP tools.
- MCP capabilities are random, task-scoped, short-lived, and revoked on completion or cancellation. Tool responses expose only status, a bounded summary, logical artifact IDs, and sanitized data; they never expose host paths.
- Generated files are realpath-, MIME-, size-, and SHA-256-checked by the artifact broker before Wechaty sends a real attachment.
- `text.prepare` supports deterministic start/end markers so later tools receive only the intended text instead of titles, instructions, citations, or adjacent content.
- Speech synthesis is registered as `voice.generate`; the generated MP3 uses the normal `file` result kind.
- Whether a request should invoke speech synthesis is decided by the main LLM intent classifier. Local text matching only strips explicit command wording and blocks narrow unresolved-title placeholders; it does not classify general sentences by suffix.
- `tools.policy.denyTools` can disable specific tools globally, for example `web.search`; `roomToolOverrides` can scope allow/deny rules to a room.
- High-risk tools, including video generation, require approval when an approver is configured. Adminless mode keeps the earlier no-approval behavior.
- Automation definitions are parsed by the text LLM into strict JSON, then validated locally. They support one-time reminders, daily schedules, weekly schedules, and fixed intervals. Before 04:00 local time, `第二天` is treated as the same calendar day for late-night scheduling. Due automations are dispatched after the Wechaty adapter starts and reuse the same task queue and tool policy as normal requests.

## Validation

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm audit --prod
git diff --check
pnpm verify:voice-agent
```

`pnpm verify:voice-agent` is an opt-in live integration check. It uses the configured main model, web search, and Doubao TTS without sending anything to WeChat.

## Important notes

- This MVP does not add friends, create rooms, invite members, or automatically join rooms.
- Video generation is asynchronous and may take several minutes. DangBot polls OpenRouter and returns the generated `.mp4` as a file when it is ready.
- Web search uses OpenRouter's web search tool by default when `search.enabled` is true. Brave Search remains available with `search.provider: brave` and `search.braveApiKey`.
- Search prompts include the current Beijing date/time and add a date anchor for time-sensitive queries, so relative phrases such as “today” and “this week” are interpreted against the current Beijing date.
- `pnpm audit --prod` is expected to pass. The project pins safe overrides and small local compatibility shims for legacy transitive packages in the Wechaty/FileBox chains; revisit these shims when upstream packages publish maintained replacements.
- Different Wechaty puppet providers have different reliability and platform constraints. Keep the adapter boundary intact when switching providers.
- Hermes mode never enables host terminal, host file editing, Computer Use, plugin/skill installation, Home Assistant, or arbitrary message sending. Administrators can approve a high-risk operation once or deny it; there is no permanent authorization.
- `AutomationScheduler` stays in Node and dispatches due work through the selected backend so asynchronous results can still be delivered to the correct WeChat room.
- Doubao TTS uses `DOUBAO_TTS_API_KEY`, resource ID `seed-tts-2.0`, and defaults to speaker `zh_male_tiancaitongsheng_uranus_bigtts`. The API key belongs in ignored local configuration or the environment, never in a tracked file.
- `config/local.yaml`, `data/`, `logs/`, and `*.memory-card.json` are intentionally ignored by git.
