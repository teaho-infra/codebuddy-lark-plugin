# 手把手读懂 codebuddy-lark-plugin

这份文档面向第一次读 TypeScript 插件代码的同学。你不需要先接入飞书；先在本地沿着一条消息走完代码路径，再运行测试，就能看懂主要设计。

## 0. 先建立一张地图

这个仓库做两件事：通过飞书长连接收消息，再通过 MCP 标准输入输出协议把消息交给 CodeBuddy；CodeBuddy 调用插件的 `reply` 工具时，插件又把回复送回飞书。

```text
飞书用户
  │ 发消息
  ▼
飞书 WebSocket → LarkBridge → ChannelServer → CodeBuddy 会话
飞书 API       ← LarkBridge ← reply 工具   ← CodeBuddy 会话
```

先认识两个名词：

- **WebSocket 长连接**：插件主动连接飞书并持续等待事件，不需要公网回调地址。
- **MCP stdio**：CodeBuddy 启动插件子进程，用子进程的标准输入和标准输出交换 JSON-RPC 消息。日志必须写到标准错误输出，否则会破坏协议。

建议按下面的顺序打开文件，不要从头到尾一次读完：

| 顺序 | 文件 | 先找什么 |
| --- | --- | --- |
| 1 | `src/index.ts` | `main()`：谁创建谁、启动顺序是什么 |
| 2 | `src/instance-config.ts` | `loadRuntimeConfig()`：当前会话选哪个 bot |
| 3 | `src/config.ts` | `loadConfig()`：配置字段和默认值 |
| 4 | `src/local-bot-leader.ts` | `LocalBotLeader`：为什么多个进程只连一个 bot |
| 5 | `src/lark-bridge.ts` | `start()`、`handleReceiveEvent()`、`sendText()` |
| 6 | `src/channel-server.ts` | `pushMessage()`、`registerTools()`、`listen()` |

## 1. 从入口 `main()` 开始

打开 `src/index.ts`，找到 `main()`，按代码顺序回答四个问题。

1. `loadDotenv()` 在哪里找 `.env`？它只给缺失的环境变量补值，所以已有进程环境变量优先。
2. `loadRuntimeConfig()` 的结果为什么可能是 `config: null`？在共享配置文件里，没有匹配当前实例的 binding 时，这个实例不接任何飞书 bot。
3. 为什么先 `channel.listen()`，再竞争端口、启动 `bridge.start()`？CodeBuddy 先要完成 MCP 握手；飞书连接不应挡住握手。
4. `LarkBridge` 和 `ChannelServer` 怎么相连？入口把 `onMessage` 回调接到 `channel.pushMessage()`，又用 `channel.setBridge(bridge)` 给回复工具一条返回飞书的路。

顺手看 `log()`：它写 `process.stderr`。以后加日志也应遵守这一点。

## 2. 看懂“当前实例对应哪个 bot”

打开 `src/instance-config.ts` 的 `loadRuntimeConfig()`。默认配置文件是 `~/.codebuddy/lark-channel.json`，仓库里的 `.codebuddy/lark-channel.example.json` 提供了可复制的示例。例如：

```json
{
  "version": 1,
  "bots": {
    "daemon-bot": {
      "app_id": "cli_daemon_id",
      "app_secret": "replace-me",
      "allowed_senders": "ou_your_open_id"
    },
    "work-bot": {
      "app_id": "cli_work_id",
      "app_secret": "replace-me",
      "allowed_senders": "ou_your_open_id"
    }
  },
  "bindings": {
    "session_kinds": { "daemon": "daemon-bot" },
    "session_ids": { "work": "work-bot" }
  }
}
```

这里的 `bots` 定义“有哪些飞书应用”，`bindings` 定义“哪个 CodeBuddy 实例使用哪个应用”。例子里的 `codebuddy --session-id work` 会匹配 `work-bot`。未匹配的会话不连接飞书。配置含 App Secret，请放在自己的 `~/.codebuddy`，不要提交到仓库；macOS/Linux 上运行 `chmod 600 ~/.codebuddy/lark-channel.json`。

接着读 `selectBot()` 的判断顺序：插件进程参数 `--lark-bot`、环境或插件选项 `bot`、会话 ID、会话名称、工作目录、会话类型、`default_bot`。越靠前优先级越高。`--lark-bot` 是 **插件进程参数**，不是 CodeBuddy 主命令的选项。主命令可用 `--session-id` 选择一个已经在 `bindings.session_ids` 中登记的实例。

如果中央文件不存在，代码回到 `src/config.ts` 的老式环境变量配置。`loadConfig()` 会校验 App ID 和 Secret，解析白名单、群聊、图片下载，以及选主端口和重试间隔。中央文件存在时，以其中的 bot 配置为准。

**小练习**：不运行程序，预测上例中没有 `--session-id` 的普通会话会选哪个 bot。然后在 `selectBot()` 最后的返回值核对答案。

## 3. 理解多个进程为什么不会重复响应

打开 `src/local-bot-leader.ts`：

1. `portForBot(appId)` 根据 App ID 算出固定的本机端口。
2. `LocalBotLeader.tryAcquire()` 尝试绑定 `127.0.0.1` 上的端口。绑定成功者才执行 `onLeader()`，也就是建立飞书长连接。
3. 若端口已被占用，当前实例保持待命，并按配置的间隔重试。持有端口的进程退出后，操作系统释放端口，待命实例可以接管。

请回到 `src/index.ts`，找到创建 `LocalBotLeader` 的位置，确认 `bridge.start()` 只在 `onLeader` 中调用。即使两个 CodeBuddy 会话错误地选中了同一个 App ID，也只有一个能建立连接。配置 `instance_port` 时，同一个 App ID 的所有实例必须使用相同端口；否则它们无法互斥。

## 4. 跟踪一条飞书消息

打开 `src/lark-bridge.ts`。从 `LarkBridge.start()` 中注册的 `im.message.receive_v1` 事件开始，跳到 `handleReceiveEvent()`：

1. 取出 `senderId`、`chatId`、`messageId` 等字段，缺少关键字段就丢弃。
2. 用 `seenMessageIds` 忽略飞书重投的同一条消息，并限制集合大小。
3. `isSenderAllowed()` 查发送者白名单；群消息还要看 `groupChatEnabled`。
4. 根据消息类型提取文本。图片会尝试下载到本地，再把路径交给 CodeBuddy。
5. 如果文本是 `yes abcde` 或 `no abcde`，就走权限决定回调；其他文本走 `onMessage` 回调。

回到 `src/index.ts`，可看到 `onMessage` 调用 `channel.pushMessage(msg)`。再打开 `src/channel-server.ts` 的 `pushMessage()`：它记录可信聊天和最后一条消息 ID，随后发出 `notifications/claude/channel`，消息就进入当前 CodeBuddy 会话。

**小练习**：假设发送者不在 `allowed_senders` 中，找出在哪一行逻辑退出，并解释为什么 `pushMessage()` 不会被调用。

## 5. 跟踪 CodeBuddy 的回复

在 `src/channel-server.ts` 搜索 `registerTools()`。它向 CodeBuddy 暴露名为 `reply` 的 MCP 工具，参数有 `chat_id`、`text` 和可选的 `in_thread`。

调用工具时，代码先检查参数，再用 `trustedChats` 确认这个聊天曾有可信的入站消息。随后调用 `LarkBridge.sendText()`；如果指定了 `in_thread` 且记录了原消息 ID，则调用 `sendReplyInThread()`。`sendText()` 会把长文本分段，用飞书 SDK 的消息 API 发送。

**小练习**：解释为什么随便提供一个从未收过消息的 `chat_id`，也不能用 `reply` 工具给它发消息。

## 6. 权限审批走哪条路

再看 `src/channel-server.ts` 的 `registerPermissionRelay()`。CodeBuddy 发出权限请求时，插件把提示发往最近活跃的可信聊天。用户在飞书回复 `yes <五位请求 ID>` 或 `no <五位请求 ID>` 后，`LarkBridge.handleReceiveEvent()` 识别它，入口回调调用 `pushPermissionDecision()`，把决定送回 CodeBuddy。

入口只在配置了明确的发送者白名单、且没有开启 `allowAllSenders` 时启用这条能力。这样你能把“谁可以批准本机工具调用”与普通收消息联系起来理解。

## 7. 动手验证，不需要飞书凭据

在仓库根目录运行：

```bash
npm install
npm test
npm run build
```

`tests/instance-config.test.ts` 用临时配置文件验证实例到 bot 的映射和覆盖顺序。`tests/leader.test.ts` 在本机回环地址启动两个竞争者，验证只有一个持有端口，以及持有者退出后待命者接管。后一组测试需要系统允许绑定 `127.0.0.1`；某些受限容器会报 `EPERM`。

构建入口是 `build.mjs`，它用 esbuild 把 `src/index.ts` 及依赖打包到 `dist/index.cjs`。`scripts/patch-dist.mjs` 处理依赖打包兼容问题。`dist/` 是发布产物，读逻辑时以 `src/` 为准。

## 8. 再读项目外围文件

- `package.json`：Node 版本、依赖和 `test`、`build` 命令。
- `.codebuddy-plugin/plugin.json`：插件名字、可配置选项、MCP 启动命令及 channel 声明。
- `.codebuddy-plugin/marketplace.json`：市场安装时用的插件元数据。
- `commands/lark-setup.md`：交互式配置命令说明。
- `README.md`：安装与运行说明；`migration.md`：从零接入飞书的操作指南。

最后尝试自己画一条完整链路：`飞书事件 → handleReceiveEvent → pushMessage → CodeBuddy → reply → sendText → 飞书`。能解释每一步的数据和检查条件，就已经读懂这个项目的核心代码了。
