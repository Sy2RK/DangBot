# DangBot 第二阶段手工验收

## 1. 发布前隔离证据

1. 记录 `ai.hermes.gateway` 的 PID、launchd 状态、配置 SHA-256 和会话目录清单；发布后四项必须一致。
2. 确认专属 `HERMES_HOME` 是项目 `.runtime/hermes/home`，API/MCP 只监听 `127.0.0.1:18642/18643`，版本为 `hermes-agent==0.19.0`，最大 run 并发 2。
3. `pnpm hermes:preflight:offline` 必须在随机端口和临时 HOME 通过，且退出后无残留进程/目录。
4. Hermes 工具面包含 14 个业务工具和 3 个作用域记忆工具；不含通用执行、共享 memory、terminal、host file/patch、execute code、Computer Use、skills、delegation、cron、Home Assistant 或消息代发。
5. `dangbot_guard` 对 `dangbot_video_generate` 触发 Hermes 审批；微信只能发送 allow-once 或 deny，不能创建 session/永久授权。
6. 浏览器是临时未登录会话，不读取用户 Chrome 配置、Cookie、扩展或另一 Hermes 的状态。
7. QuickJS 中 `process`、`require`、`fetch`、`XMLHttpRequest`、Shell 和宿主路径均不可用；无限循环超时。

## 2. 启动和唯一后端

1. 缺少 Hermes API key/session secret、MCP key、Memory Bridge key或 DashScope key时 DangBot 必须启动失败。
2. 代码与配置中不存在 `agent.backend`、`legacy|hermes` 开关、旧分类器、模板计划、通用 ToolRegistry Agent 循环或 Brave/OpenRouter 搜索路径。
3. 发送一个复合原始请求，数据库 task 只记录 `origin` 和原始 prompt；不写 requestType、toolName 或 toolInput。
4. 观察 Hermes 能连续调用多个一等工具，并在第一个工具返回结构化错误后选择其他安全方案；微信只看到节流进度和最终回答，不显示 reasoning。
5. 发送含糊且可能产生费用的请求，Hermes 应用普通回复问必要问题，不调用交互式 clarify 工具，也不先创建付费任务。

## 3. 会话、附件和 MCP

1. 不同群、不同用户和不同 epoch 的 session ID/session-key 哈希必须不同，且不含原始群/用户 ID；日志不能记录原始 session key。
2. `@DangBot 清空上下文` 后 epoch 加一，下次不续接旧 Hermes session；不创建 Node 个人聊天摘要。
3. 当前消息附件加同群同用户最近最多 5 个有效附件会进入任务。其他用户、其他群、过期或未关联附件不可见。
4. 伪造、过期、已撤销或跨 task 的 contextId 均返回结构化错误；capability 重放失败。
5. 所有 MCP 响应只有 `status/summary/artifactIds/data`，不得出现 `/Users/`、`/home/`、`/private/`、Windows 盘符路径或原始文件路径。
6. TXT/MD/CSV/DOCX/PDF/XLSX 用 `attachmentId + cursor + maxChars` 分页抽取；相同输入返回相同页，不调用任何文字模型。
7. 路径穿越、输出目录外文件和指向目录外的 symlink 均被 Artifact Broker 拒绝。

## 4. 对话、Web 和浏览器

1. `@DangBot 解释 TypeScript strict mode` 只由专属 `deepseek-v4-flash` 回答。
2. `@DangBot 搜索今天 Qwen 的新闻并附来源` 使用 Hermes `web_search` 和固定 DDGS 后端，日期按当前北京时间解释。
3. 需要页面交互的请求使用临时浏览器；验收后会话关闭，不留下登录状态。
4. 普通未 @ 群消息不触发回复，但进入最多 24 小时、有数量上限的群公开窗口；`dangbot_room_context` 不能跨群。

## 5. 文件与媒体

1. 图片分析和视频分析的工具记录显示 `qwen3.7-flash`，DeepSeek 负责综合结论。
2. `@DangBot 生成图片：...` 调用 `qwen-image-3.0-pro`；1–3 张参考图的逻辑 ID、顺序和归属与请求一致。供应商返回 403 时显示准确权限错误，不宣称附件已生成。
3. 视频严格路由：
   - 无媒体：`happyhorse-1.1-t2v`；
   - 恰好一张 frame：`happyhorse-1.1-i2v`；
   - 2–9 张 reference image：`happyhorse-1.1-r2v`；
   - 一个 source video 加最多 5 张 reference image：`happyhorse-1.0-video-edit`。
4. 混用 frame/source、文生视频携带附件、参考模式少于两张或视频编辑超过五张均在供应商调用前拒绝。
5. 两个视频任务同时发起时只有一个取得资源租约，另一个得到 `resource_busy` 并允许 Hermes 重规划。
6. TTS 只接收 Hermes 准备的最终正文，调用 `qwen-audio-3.0-tts-flash` 并回传通过 WAV 魔数校验的文件。
7. Hermes 组织标题和正文后，`dangbot_document_render` 确定性生成 DOCX/TXT/MD；DOCX 用 Mammoth 验证含预期正文。
8. 输入附件在每次工具调用前重新核对上传根目录、内容类型、MIME、大小与 SHA-256；图片、音频、视频、DOCX 产物也通过同类校验，接收方收到真实 FileBox 附件，不是本地路径文本。

## 6. 审批与取消

1. 普通成员发起明确视频生成后，Hermes run 进入 waiting approval；管理员同意一次后原调用继续，拒绝则不调用供应商。
2. 普通成员不能替别人或跨群审批；过期审批不能重跑、不能转永久授权。
3. 任务执行中发送 `取消 task_...`：Hermes 收到 `/stop`，MCP capability 被撤销，QuickJS 中止，DashScope 异步任务尝试 cancel，任务不能晚到投递。
4. SSE 人为断开后，DangBot 通过 run status 轮询得到 completed/failed/cancelled 或 waiting approval。

## 7. 作用域记忆与反思

1. `记住：我喜欢简短回答` 只写当前群当前用户 manual 个人记忆；同用户在另一群召回不到。
2. 管理员 `全局记住：默认中文` 只写当前群 room 记忆；其他群召回不到。
3. Provider prefetch 同时只返回当前个人、本群共享和已批准 Agent lesson；伪造 session key、跨群 key 和 reflection/interactive purpose 混用均失败。
4. `我的记忆` 返回逻辑 ID；`忘记 mem_...` 只能精确删除本人在当前群的一条个人记忆，`清空我的记忆` 不影响别人和群记忆；`清空全局记忆` 需要管理员且只影响本群。
5. 构造用户纠正/稳定偏好候选：累计 5 个或空闲 15 分钟触发；每批最多 8 个任务，同会话 30 分钟内不重复。
6. reflection 使用独立 session/capability，只能调用三个记忆工具，不调用 Web、浏览器、文件、媒体、JavaScript 或自动任务，也不向微信群发答案。
7. 个人自动写入必须同时满足 confidence >= 0.95、evidence 是足够长度的该批用户原话、content 被 evidence 直接支持、无冲突、非敏感、非临时、每批最多一条；单字证据、无关内容、手机号、邮箱和长数字证据必须降级为 pending proposal。
8. `记忆提案` 只列出当前身份有权审批的 pending 项：个人提案只有本人可批，room 提案只有群/系统管理员可批，agent lesson 只有系统管理员可批。系统管理员可用 `Agent 经验` 取得 `lesson_...`，再用 `撤销 Agent 经验 lesson_...` 停止跨群召回；群管理员和普通成员均被拒绝。
9. 让反思 Hermes 首次执行失败、第二次成功：候选在失败后重新变为 due，第二批成功后才保持 consumed，不得静默丢失。
10. 自动写入在该用户下一次正常回复后透明提示，并可按逻辑 ID 精确删除或清空个人记忆。
11. 迁移数据库确认只剩 manual 个人/本群记忆；旧自动摘要、`room_id='*'` 和 Node contexts 已删除。

## 8. 自动任务

1. 管理员用自然语言创建一次、每天、每周和 interval 自动任务；Hermes 调用严格 schema，Node 拒绝非法日期、时区或字段类型。
2. `自动化列表`、暂停、恢复和删除只作用当前群；普通成员不能修改。
3. 到期后 Node 只负责唤醒；新 task 的 origin 是 `automation`，并重新进入同一 Hermes/MCP/审批/artifact 链路。
4. 提醒结果能可靠回推原微信群，不使用 Hermes Cron 或消息代发。
5. 模拟 Agent 已开始后附件投递失败：同一到期执行不得再次进入 Hermes；触发消息、付费媒体和部分产物不能因自动重试而重复。

## 9. 发布门禁

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
git diff --check
pnpm audit --prod
pnpm hermes:preflight:offline
```

完成全仓审查，重点检查旧 Agent 残留、隐藏文字 LLM、权限绕过、跨群记忆、并发取消、密钥/路径泄漏和文档真实性；修复后重新跑全部门禁。最后在真实测试群覆盖本清单，再复核非 DangBot Hermes 的四项基线完全未变。
