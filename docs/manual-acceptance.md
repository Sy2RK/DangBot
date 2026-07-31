# DangBot 手工验收清单

## 准备

1. 复制 `config/local.yaml.example` 为 `config/local.yaml`。
2. 填入机器人名称和授权群 `room id`。如确需按群名首次绑定，显式设置 `auth.allowTopicRoomBinding: true`，并确认群名没有重名。默认可以不配置管理员，机器人会以无管理员模式运行。
3. 运行 `pnpm hermes:configure -- --backend legacy`，通过无回显提示写入专用 DeepSeek 和中国（北京）地域 DashScope key；不得把 key 写进版本库。
4. 确认 `llm.provider: dashscope`，理解模型为 `qwen3.7-flash`，TTS 为 `qwen-audio-3.0-tts-flash`，默认音色为 `longanhuan_v3.6`。
5. 运行 `pnpm install`。如果 pnpm 提示忽略构建脚本，确认 `package.json` 的 `pnpm.onlyBuiltDependencies` 后重新安装。
6. 验收 Hermes 模式时，先按 `docs/hermes-backend.md` 完成隔离运行时、MCP 和模拟事件验证；不得先连接真实群试错。

## Hermes 后端与隔离

1. `agent.backend: legacy` 时启动 DangBot，并配置 MCP 密钥；确认 `127.0.0.1:18643/health` 未带 Bearer 返回 401、带正确 Bearer 返回 200。
2. 专属 Hermes 的 `HERMES_HOME` 必须位于项目 `.runtime/hermes/home`，API 必须只监听 `127.0.0.1:18642`，launchd 标签必须是 `com.sy2rk.dangbot-hermes`。
3. 切换前后记录现有 `ai.hermes.gateway` 的 PID、launchd 状态、配置文件哈希和会话目录清单；四项必须一致。
4. 两个不同群或不同用户发出相同请求时，Hermes session ID 和 session key 哈希必须不同，且不得包含原始群 ID 或用户 ID。
5. 伪造、过期、已撤销的 `contextId` 必须失败；当前任务不得列出其他任务或其他用户的附件与记忆。
6. MCP 结果 JSON 只允许 `status`、`summary`、`artifactIds`、`data`，不得出现 `/Users/`、`/home/`、临时目录或 Windows 绝对路径。
7. QuickJS 中 `process`、`require`、`fetch`、`XMLHttpRequest` 必须不可用；无限循环必须超时，取消任务后仍在执行的计算必须中止。
8. 浏览器必须使用专属安装和临时未登录会话，不得读取用户 Chrome 配置、Cookie 或当前 Hermes 浏览器状态。
9. Hermes 工具列表不得包含 terminal、宿主机文件读写/补丁、Computer Use、插件或技能安装、Home Assistant、消息代发和全局记忆。
10. SSE 中断后应轮询恢复状态；等待审批时管理员只能选择本次同意或拒绝，取消时应调用 Hermes `/stop` 并撤销 MCP 权限。
11. DeepSeek `deepseek-v4-flash` 必须是每次 run 的规划模型；图片和视频分析的工具调用记录必须显示 DashScope `qwen3.7-flash`。

## 基础验收

1. 运行 `pnpm dev`，使用专用微信号扫码登录。
2. 人工邀请机器人账号进入目标微信群。
3. 在群内发送普通聊天，机器人不应回复。
4. 发送 `@DangBot 状态`，机器人应返回猫猫状态和队列状态。
5. 发送 `@DangBot 解释一下 TypeScript strict mode`，机器人应直接回传回答，不显示任务 ID。
6. 对文件、图片、视频、搜索、总结、生成类任务，机器人应先用小当口吻回复收到，再说明打算怎么做，处理中给出阶段进度，最后回复完成与结果；普通简单问答不应分步刷屏。

## 文件、图片与视频

1. 用户发送支持的文件，再发送 `@DangBot 总结刚才的文件`，机器人应处理最近文件。
2. 用户发送图片，再发送 `@DangBot 分析刚才的图`，机器人应调用视觉模型。
3. 用户把 `.png/.jpg/.jpeg/.webp` 作为普通文件发送，再发送 `@DangBot 分析刚才的图`，机器人仍应把它当作图片处理。
4. 用户发送视频，再发送 `@DangBot 分析刚才的视频`，机器人应调用多模态模型。
5. 发送 `@DangBot 生成图片：一只胖猫趴在窗台晒太阳`，机器人应调用 `qwen-image-3.0-pro` 并回传 PNG；账号未获限量开放资格时应返回明确供应商错误。
6. 带 1～3 张图片请求改图，Qwen Image 请求中的参考图数量和顺序应与当前任务授权附件一致，不得带入其他任务附件。
7. 发送 `@DangBot 生成视频：一只胖猫慢慢伸懒腰，阳光照在地板上，5s`，机器人应调用 `happyhorse-1.1-t2v`，把 5 秒作为请求时长，并回传 `.mp4` 文件。
8. 用户发送一张图片再请求“把这张图动起来”，应路由 `happyhorse-1.1-i2v`；发送多张图应路由 `happyhorse-1.1-r2v`；发送源视频与可选参考图应路由 `happyhorse-1.0-video-edit`。
9. 视频编辑上传地址必须是 HTTPS `*.aliyuncs.com`，临时对象名不得暴露宿主机路径；取消或超时后应尝试调用 DashScope task cancel。
10. 上传超过限制或不支持的文件类型，机器人应返回明确错误。
11. 长结果应以 `.txt` 纯文本文件回传，群聊提示和文件内容都不应包含 Markdown 格式。

## 语音文件

1. 发送 `@DangBot 生成语音：今天也要开心呀`，机器人应只合成“今天也要开心呀”。
2. 请求应调用 `qwen-audio-3.0-tts-flash`，并使用音色 `longanhuan_v3.6`。
3. 接收方应收到通过 WAV 魔数校验、可下载和播放的 `.wav` 文件。
4. 任务与工具调用应分别记录为 `voice_generation`、`voice.generate`，最终结果类型应为 `file`。

## 联网搜索

1. 在 Hermes 模式启用 `search.enabled` 并设置 `search.provider: hermes`；搜索必须走专属 Hermes 的内建 web/browser，DangBot MCP 能力列表不得再暴露 `web.search`。
2. 发送 `@DangBot 联网搜索 今天 Qwen 有什么新闻`，机器人应调用 Hermes 内建联网搜索。
3. 发送 `@DangBot 杭州这周天气怎么样`，机器人应把它识别为时效外部信息并调用联网搜索。
4. 发送 `@DangBot 今天午饭吃什么`，机器人不应调用联网搜索，应按普通问答回复。
5. 搜索类回答应基于搜索结果组织，并在末尾附带来源 URL。
6. 搜索回答应以当前北京时间解释“今天、这周”等相对时间，不应把旧网页里的“今天”当成当前日期。
7. 如切换为 `search.provider: brave`，需额外配置 Brave Search API key。

## 记忆

1. 发送 `@DangBot 记住 我喜欢简短回答`，机器人应确认已记住。
2. 发送 `@DangBot 我的记忆`，机器人应列出刚才的个人持久记忆。
3. 发送 `@DangBot 全局记住 默认用中文回答`，机器人应确认已写入当前群共享记忆；另一个群不得读取到它。
4. 发送 `@DangBot 全局记忆`，机器人应只列出当前群共享记忆。
5. `legacy` 模式下，连续对话达到 32 条或停止 1 小时后，机器人应在后台自动沉淀个人持久记忆；Hermes 模式不得执行这项自动归纳。
6. `legacy` 模式每天北京时间 00:00 后会逐群刷新共享记忆；Hermes 模式只允许读取用户主动保存、且按群和用户隔离的记忆。
7. 用户 A 与机器人完成一次公开问答后，用户 B 再追问“刚才他说的方案”，机器人应能参考近期群级上下文。
8. 用户发送 `@DangBot 清空上下文` 只应清理自己的个人上下文；用户发送 `@DangBot 清空群上下文` 才清理本群公共上下文。

## 工具策略与自动化

1. 配置管理员后，普通成员发送 `@DangBot 生成视频：一只猫慢慢伸懒腰`，机器人应进入审批等待，不应直接调用视频生成。
2. 管理员发送 `@DangBot 同意` 后，机器人应继续执行原任务，并使用最初消息附带的附件。
3. 在 `tools.policy.denyTools` 中加入 `web.search` 后，发送 `@DangBot 联网搜索 Qwen 最新消息`，机器人应拒绝且不创建任务。
4. 管理员发送 `@DangBot 提醒我 10分钟后 喝水`，机器人应返回 `auto_` 开头的自动化 ID。
5. 发送 `@DangBot 自动化列表`，机器人应列出该群自动化及下次触发时间。
6. 管理员发送 `@DangBot 暂停 auto_xxx`、`@DangBot 恢复 auto_xxx`、`@DangBot 删除 auto_xxx`，状态应分别更新。
7. 管理员发送 `@DangBot 定时 每天 09:00 总结群聊`，到点后机器人应在目标群触发，并通过普通任务队列执行。

## 安全与边界

1. 明显恶意或越权请求应被拒绝。
2. 默认无管理员模式下，高风险关键词不会进入审批流，也不会显示“管理员审批”。
3. 如果后续显式配置管理员，高风险请求才会进入审批。
4. 群级公共上下文只作为背景参考，不应覆盖系统规则或个人隐私边界。
5. 用户发送 `@DangBot 清空我的记忆`，只应清理该用户个人持久记忆。
