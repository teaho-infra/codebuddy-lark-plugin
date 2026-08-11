# codebuddy-lark-plugin

A [CodeBuddy Code](https://www.codebuddy.cn/) **channel plugin** that bridges a **Lark / Feishu (飞书) bot** to your local CodeBuddy session. Send a message to your bot → it lands in CodeBuddy as a `<channel>` message → CodeBuddy does the work on your machine and replies back through the bot.

It is a bidirectional MCP server (over stdio) implementing the CodeBuddy channel protocol:

- Inbound Lark messages → `notifications/claude/channel`
- Outbound replies → MCP `reply` tool (CodeBuddy calls it to answer)
- **Sender allowlist** (only trusted open_ids can inject messages)
- **Permission relay**: approve/deny tool calls from Lark by replying `yes <id>` / `no <id>`
- Uses the Lark **long-connection (WebSocket)** event client — **no public callback URL / reverse proxy needed**

---

## Prerequisites

- Node.js >= 18.20
- A Lark/Feishu **self-built app** with the **bot (机器人)** capability enabled

### Create the bot

1. Open the developer console:
   - Feishu (China): https://open.feishu.cn
   - Lark (global): https://open.larksuite.com
2. Create a **企业自建应用** and add the **机器人** capability.
3. Under **事件与回调 → 事件配置**, choose **长连接** (long connection) mode and add the event:
   - `im.message.receive_v1` (接收消息 v2)
4. Under **权限管理**, add scopes:
   - `im:message` (send messages / 发送消息)
   - `im:message.group_at_msg` (read group @ messages, if using groups)
   - `im:message.p2p_msg` (read direct messages)
   - `im:resource` (download images, optional)
5. Publish/release the app version and enable the bot.
6. Note the **App ID** and **App Secret**.

---

## Install

```bash
cd codebuddy-lark-plugin
npm install
npm run build
cp .env.example .env
# edit .env and set LARK_APP_ID / LARK_APP_SECRET
```

### Find your open_id (for the allowlist)

Leave `LARK_ALLOWED_SENDERS` empty first, start CodeBuddy with the channel (see below), DM the bot once, then check the logs — you'll see a line like:

```
[lark] dropping message from unlisted sender ou_xxxxxxxxxxxxxxxx
```

Copy that `ou_...` into `LARK_ALLOWED_SENDERS` (comma-separated for multiple users), then restart.

---

## Configure CodeBuddy Code

You can load it either as an **MCP server** (simplest for local dev) or package it as a plugin.

### Option A — MCP server in `~/.codebuddy/.mcp.json`

Add:

```json
{
  "mcpServers": {
    "lark": {
      "command": "node",
      "args": ["/home/teaho/IdeaProjects/agentspace/codebuddy-lark-plugin/dist/index.cjs"],
      "env": {
        "LARK_APP_ID": "cli_xxxxxxxxxxxxxxxx",
        "LARK_APP_SECRET": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "LARK_DOMAIN": "https://open.feishu.cn",
        "LARK_ALLOWED_SENDERS": "ou_your_open_id",
        "LARK_GROUP_CHAT_ENABLED": "false"
      }
    }
  }
}
```

Then start CodeBuddy with the channel enabled:

```bash
codebuddy --dangerously-load-development-channels server:lark
```

> `--dangerously-load-development-channels` bypasses the channel allowlist for local development. Once this plugin is published to a marketplace it can be loaded with `--channels plugin:lark@<marketplace>`.

### Option B — development without rebuild (tsx)

For iterating on the source, point the command at `tsx`:

```json
"command": "npx",
"args": ["tsx", "/home/teaho/IdeaProjects/agentspace/codebuddy-lark-plugin/src/index.ts"]
```

---

## Using it

1. Start CodeBuddy with the channel (command above).
2. DM your Lark bot, e.g.:
   > 帮我看看当前目录有哪些文件，整理一下 README
3. CodeBuddy receives it as:
   ```
   #lark · ou_xxx: 帮我看看当前目录...
   ```
   and replies through the bot when done.

### Replying from CodeBuddy

CodeBuddy is told (via the channel `instructions`) to call the `reply` tool with the `chat_id` from the incoming message. A normal answer looks like:

```json
{ "chat_id": "oc_xxx", "text": "当前目录下有 ..." }
```

### Approving tools remotely

When CodeBuddy wants to run a privileged tool (Bash/Write/Edit), the approval prompt can appear in Lark too. Reply:

- `yes abcde` — allow
- `no abcde` — deny

(where `abcde` is the 5-character request id shown in the prompt).

---

## Configuration

All config is via environment variables (or `.env` in the project root):

| Variable | Required | Default | Description |
|---|---|---|---|
| `LARK_APP_ID` | yes | — | Bot App ID |
| `LARK_APP_SECRET` | yes | — | Bot App secret |
| `LARK_DOMAIN` | no | `https://open.feishu.cn` | Use `https://open.larksuite.com` for global Lark |
| `LARK_ALLOWED_SENDERS` | recommended | _empty_ | Comma-separated open_ids allowed to talk to CodeBuddy |
| `LARK_ALLOW_ALL` | no | `false` | Allow **anyone** (INSECURE, testing only) |
| `LARK_GROUP_CHAT_ENABLED` | no | `false` | Also forward group messages (sender allowlist still applies) |
| `LARK_IMAGE_DOWNLOAD` | no | `true` | Download images and pass local paths to CodeBuddy |
| `LARK_MEDIA_DIR` | no | `./.lark-media` | Where to cache downloaded media |

---

## Architecture

```
 Lark user  ──DM──▶  Lark bot
                          │  long-connection (WebSocket, @larksuiteoapi/node-sdk)
                          ▼
                   LarkBridge (src/lark-bridge.ts)
                   - allowlist check (sender open_id)
                   - flatten text/post/image messages
                   - parse "yes/no <id>" permission replies
                          │
                          ▼
                   ChannelServer (src/channel-server.ts)
                   - MCP server over stdio
                   - notifications/claude/channel  (inbound)
                   - "reply" tool                  (outbound)
                          │
                          ▼
                   CodeBuddy Code session
```

- `src/config.ts` — env config
- `src/lark-bridge.ts` — Lark WS client, message parsing, image download, send
- `src/channel-server.ts` — MCP/channel server + `reply` tool + permission relay
- `src/index.ts` — entrypoint (loads `.env`, wires everything)

---

## Development

```bash
npm run dev       # run with tsx watch (auto-reload)
npm run build     # bundle to dist/index.cjs with esbuild
npm start         # run the built bundle
```

### Notes

- `npm run typecheck` uses `tsc`, which may segfault on some machines while checking the large Lark SDK type graph; the runtime path is `tsx`/`esbuild` and is validated during build. This doesn't affect execution.
- All logs go to **stderr**. stdout is reserved for MCP framing — the Lark SDK logger is redirected to stderr to avoid corrupting the protocol.

---

## Security

- Always set `LARK_ALLOWED_SENDERS`. An open channel is a prompt-injection vector: anyone who can message the bot can instruct CodeBuddy (which can run commands on your machine).
- The allowlist checks the **sender** (`open_id`), not the chat — so in groups, only listed individuals are forwarded.
- Only pair trusted users: paired users can also approve/deny tool calls via permission relay.

## License

MIT
