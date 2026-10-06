# codebuddy-lark-plugin 从零接入指南

本文面向第一次拿到本仓库的人：从创建飞书应用开始，到在 CodeBuddy Code 里跑通「Lark 发消息 → CodeBuddy 干活 → 机器人回消息」。

如果同时运行多个 CodeBuddy（包括 daemon），请优先使用
[`~/.codebuddy/lark-channel.json` 多实例配置](README.md#one-shared-bot-file-for-multiple-codebuddy-sessions-recommended)：
按会话 ID、名称、工作目录或 `daemon` 类型把实例分配给不同 bot。未匹配的实例不会连接飞书；同一 App ID 即使重复分配，本机也只会有一个连接。下面第 3 节的 `settings.json` / `credentials.json` 是旧版单 bot 配置方式；中央文件存在时以中央文件为准。

架构一句话：本插件是一个 stdio MCP 服务器（channel 插件），通过飞书长连接（WebSocket）收发消息，**不需要公网回调地址 / 反向代理**。

```
Lark 用户 ──DM──▶ 飞书机器人
                      │ 长连接 (@larksuiteoapi/node-sdk)
                      ▼
              LarkBridge  (allowlist 校验 / 消息解析 / 权限转发)
                      ▼
              ChannelServer (MCP over stdio)
                      ▼
              CodeBuddy Code 会话
```

---

## 1. 准备工作

- Node.js >= 18.20
- 已安装 CodeBuddy Code
- 一个飞书 / Lark **企业自建应用**（机器人）

### 1.1 创建飞书应用

1. 打开开发者后台：
   - 飞书（国内）：https://open.feishu.cn
   - Lark（海外）：https://open.larksuite.com
2. 创建**企业自建应用**，在「添加应用能力」中开启**机器人**。
3. 「事件与回调 → 事件配置」：订阅方式选择**长连接**，添加事件：
   - `im.message.receive_v1`（接收消息 v2）
4. 「权限管理」中申请以下 **应用（bot）权限**（不要走用户 OAuth）：
   - `im:message`（发消息）
   - `im:message.p2p_msg`（读私聊消息）
   - `im:message.group_at_msg`（读群 @ 消息，用群才需要）
   - `im:resource`（下载图片，可选）
5. **发布应用版本**并启用机器人。
6. 记下 **App ID**（`cli_...`）和 **App Secret**。

## 2. 安装插件

插件 ID：`codebuddy-lark-channel`；marketplace 名取自 `.codebuddy-plugin/marketplace.json` 的 `name` 字段，即 `codebuddy-lark-plugin`。

### 方式 A：作为 marketplace 安装（推荐，团队/社区分发）

```bash
# 远程仓库（推到 GitHub 等 Git 托管后）
codebuddy plugin marketplace add OWNER/REPO
codebuddy plugin install codebuddy-lark-channel@codebuddy-lark-plugin

# 本地目录（试用本仓库）
codebuddy plugin marketplace add /absolute/path/to/codebuddy-lark-plugin
codebuddy plugin install codebuddy-lark-channel@codebuddy-lark-plugin
```

安装后重启 CodeBuddy（或 `/reload-plugins`），channel 即被加载。

> **更新已安装插件**：先构建，并同步提高 `package.json`、`plugin.json`、`marketplace.json` 的版本号，然后 `git commit`。如果 marketplace 来源是 GitHub，还要 `git push`；若来源是本地目录则不需要推送。接着执行 `codebuddy plugin marketplace update codebuddy-lark-plugin` 和 `codebuddy plugin update codebuddy-lark-channel@codebuddy-lark-plugin`，最后重启 CodeBuddy（daemon 用 `codebuddy daemon restart`）。不要复用旧版本号，否则 `plugins/cache/<mp>/<plugin>/<version>` 可能继续提供旧代码。

### 方式 B：直接配置为 MCP 服务器（免安装，本地调试）

编辑 `~/.codebuddy/.mcp.json`：

```json
{
  "mcpServers": {
    "lark": {
      "command": "node",
      "args": ["/absolute/path/to/codebuddy-lark-plugin/dist/index.cjs"],
      "env": {
        "LARK_APP_ID": "cli_xxxxxxxxxxxxxxxx",
        "LARK_APP_SECRET": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "LARK_DOMAIN": "https://open.feishu.cn",
        "LARK_ALLOWED_SENDERS": "ou_your_open_id"
      }
    }
  }
}
```

启动时带上 channel 加载开关：

```bash
codebuddy --dangerously-load-development-channels server:lark
```

（方式 A 安装的插件不需要这个 flag；它只在本地开发时绕过 channel 白名单。）

## 3. 写入配置（App ID / Secret / 白名单）

注意：CodeBuddy **不会**在安装时弹窗询问 `userConfig`（实测 2.142.0，`savePluginOptions()` 从未被调用），必须手动写入或用本插件提供的 `/lark-setup` 命令。

### 方式 A 插件安装：用 /lark-setup

在 CodeBuddy 里运行 `/lark-setup`，按提示输入：

- `app_id`
- `app_secret`（敏感，单独存）
- `allowed_senders`
- `domain`
- `group_chat_enabled`
- `image_download`
- `allow_all`

它会自动写到正确的位置。也可以手写：

| 类型 | 文件 | 位置 |
| --- | --- | --- |
| 非敏感 | `~/.codebuddy/settings.json` | `pluginConfigs["codebuddy-lark-channel@codebuddy-lark-plugin"].options` |
| 敏感（app_secret） | `~/.codebuddy/credentials.json`（chmod 600） | `pluginSecrets["codebuddy-lark-channel@codebuddy-lark-plugin"]` |

```jsonc
// ~/.codebuddy/settings.json
{
  "pluginConfigs": {
    "codebuddy-lark-channel@codebuddy-lark-plugin": {
      "options": {
        "app_id": "cli_xxxxxxxxxxxxxxxx",
        "allowed_senders": "ou_xxxxxxxxxxxxxxxx",
        "domain": "https://open.feishu.cn",
        "group_chat_enabled": "false",
        "image_download": "true",
        "allow_all": "false"
      }
    }
  }
}
```

```jsonc
// ~/.codebuddy/credentials.json
{
  "pluginSecrets": {
    "codebuddy-lark-channel@codebuddy-lark-plugin": {
      "app_secret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
    }
  }
}
```

运行时这些值会以 `CODEBUDDY_PLUGIN_OPTION_<KEY>` 环境变量传给 MCP 进程；显式 `LARK_*` 变量和本地 `.env` 优先级更高。

> 注意：stdio MCP 不会继承所有 shell 环境变量，但插件启动后会自行搜索 `.env`，包括 `~/.codebuddy/.env`。若使用多实例中央配置 `lark-channel.json`，则由匹配到的 bot 配置决定 App ID 与 Secret。

### 方式 B 直接 MCP：.env 或 env 块

仓库根目录 `cp .env.example .env` 后填 `LARK_APP_ID` / `LARK_APP_SECRET`，或在 `.mcp.json` 的 `env` 块里直接写（见上）。

## 4. 拿到你的 open_id（配置白名单）

1. 先把 `allowed_senders` / `LARK_ALLOWED_SENDERS` 留空启动。
2. 在飞书私聊机器人发一条消息。
3. 看日志（stderr）找到：

   ```
   [lark] dropping message from unlisted sender ou_xxxxxxxxxxxxxxxx
   ```

4. 把这个 `ou_...` 填入 `allowed_senders`（多人逗号分隔），重启 CodeBuddy 或 `/reload-plugins`。

## 5. 验证与使用

1. 启动 CodeBuddy（方式 A 直接启动；方式 B 带上面 flag）。
2. 私聊机器人，例如：

   > 帮我看看当前目录有哪些文件，整理一下 README

3. CodeBuddy 收到 `<channel source="lark" ...>` 消息，干活后调用 `reply` 工具（参数 `chat_id` + `text`）回复到 Lark。
4. 权限转发：当 CodeBuddy 要执行 Bash/Write/Edit 等敏感工具时，审批请求会出现在 Lark，回复：
   - `yes abcde` 允许
   - `no abcde` 拒绝

   （`abcde` 是提示中的 5 位请求 ID。）

## 6. 从源码构建（如果 dist 不在 / 要改代码）

```bash
npm install
npm run build        # esbuild 打包到 dist/index.cjs
npm run dev          # tsx watch，改源码不重打包
npm run package:plugin  # 产出 release/codebuddy-lark-plugin.tgz（无凭据发布包）
```

`dist/index.cjs` 是打包产物，用户安装后无需再装 Node 依赖。

## 7. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 消息不进来 | 白名单没配（看日志里 `unlisted sender`）；或应用没发布版本；或事件没选长连接模式 |
| 改了配置不生效 | 配置在插件加载时读取，重启 CodeBuddy 或 `/reload-plugins` |
| 重新 install 还是旧代码 | 版本号没 bump，缓存复用；bump 三处 version 后重来 |
| CodeBuddy 启动时插件没起来 | 看启动日志 stderr 的 `fatal:` 行；确认 App ID/Secret 正确、事件订阅已添加 |
| 机器人日志把 MCP 弄乱 | 不会——所有日志强制走 stderr，stdout 只用于 MCP JSON-RPC |

## 8. 安全须知

- **务必配置 `allowed_senders`**。开放通道是提示注入攻击面：任何能私聊机器人的人都能指挥 CodeBuddy 在你的机器上执行命令。`allow_all=true` 仅限测试。
- 白名单校验的是**发送者 open_id**（不是群 ID），群里也只放行名单内的人。
- 出站回复只允许发往已经产生过认证入站消息的会话。
- 同一 `message_id` 的重复事件投递会被忽略。
- 白名单内的用户同时可以远程审批/拒绝工具调用，请只配对信任的人。
