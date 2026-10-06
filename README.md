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
   These are **bot/application scopes**. Do not run a user OAuth login for this
   plugin; grant the scopes to the app in the developer console.
5. Publish/release the app version and enable the bot.
6. Note the **App ID** and **App Secret**.

---

## Install

```bash
cd codebuddy-lark-plugin
npm install
npm run build
# For a single bot without the shared config, copy .env.example to .env.
# For multiple instances, configure ~/.codebuddy/lark-channel.json below.
```

### Find your open_id (for the allowlist)

Leave `allowed_senders` in the shared bot profile (or legacy `LARK_ALLOWED_SENDERS`) empty first, start CodeBuddy with the channel (see below), DM the bot once, then check the logs — you'll see a line like:

```
[lark] dropping message from unlisted sender ou_xxxxxxxxxxxxxxxx
```

Copy that `ou_...` into `allowed_senders` (or legacy `LARK_ALLOWED_SENDERS`; comma-separated for multiple users), then restart.

---

## Configure CodeBuddy Code

### Only the daemon connects (no shared bot file)

For one bot that should respond only through the CodeBuddy daemon, add
`"daemon_only": "true"` to this plugin's options in
`~/.codebuddy/settings.json`:

```json
{
  "pluginConfigs": {
    "codebuddy-lark-channel@codebuddy-lark-plugin": {
      "options": {
        "app_id": "cli_your_app_id",
        "allowed_senders": "ou_your_open_id",
        "daemon_only": "true"
      }
    }
  }
}
```

Keep `app_secret` in `~/.codebuddy/credentials.json` under
`pluginSecrets["codebuddy-lark-channel@codebuddy-lark-plugin"]`, as shown in
the legacy configuration section below. `daemon_only` requires the plugin
process to receive `CODEBUDDY_SESSION_KIND=daemon`. An interactive or
background session, or one with an unknown kind, stays inactive and logs the
observed kind. The daemon uses the App ID, Secret and other plugin options
from CodeBuddy settings. When `daemon_only` is true, an existing
`lark-channel.json` is ignored; you do not need to create one. Set it to
`"false"` to return to the normal bot selection rules.
After updating the plugin and restarting CodeBuddy, the daemon log should say
`selected Lark bot legacy via daemon_only settings`; an ordinary session
should say `no Lark bot selected (daemon_only (kind=interactive))`.

### One shared bot file for multiple CodeBuddy sessions (recommended)

Put your bot profiles and instance bindings in `~/.codebuddy/lark-channel.json`
(or `$CODEBUDDY_CONFIG_DIR/lark-channel.json` if that directory is configured).
Start from [the example](.codebuddy/lark-channel.example.json) if this is your
first setup; replace its placeholder credentials in your private copy.
Keep this file outside the repository and restrict access because it contains
App Secrets (`chmod 600 ~/.codebuddy/lark-channel.json` on macOS/Linux).

```json
{
  "version": 1,
  "bots": {
    "daemon-bot": {
      "app_id": "cli_daemon_bot_id",
      "app_secret": "daemon-bot-secret",
      "allowed_senders": "ou_your_open_id"
    },
    "project-bot": {
      "app_id": "cli_project_bot_id",
      "app_secret": "project-bot-secret",
      "allowed_senders": "ou_your_open_id",
      "group_chat_enabled": false
    }
  },
  "bindings": {
    "session_kinds": { "daemon": "daemon-bot" },
    "session_ids": { "my-project": "project-bot" },
    "workspaces": { "/absolute/path/to/project": "project-bot" }
  }
}
```

For an ordinary session, `codebuddy --session-id my-project` selects
`project-bot`. A daemon worker uses `daemon-bot`. An unmatched process keeps
its MCP channel available but does not connect to any bot. You can also bind
`session_names` (for named background sessions) or set `default_bot` if every
unmatched instance should compete for one bot. Bindings are checked in this
order: session ID, session name, exact absolute workspace path, session kind,
then `default_bot`. CodeBuddy session kinds are `interactive`, `bg`, and
`daemon`.

The `--lark-bot <name>` **plugin process argument** overrides the bindings.
It can be put in an MCP server's `args` array; it is not a top-level
`codebuddy` option. `LARK_BOT` or the plugin option `bot` also overrides the
bindings. A per-process CodeBuddy `--settings` value can set that plugin
option. `--lark-config <path>`, `LARK_BOT_CONFIG`, or the plugin option
`bot_config` changes the JSON file path. The central file takes precedence
over legacy `LARK_APP_ID` / `LARK_APP_SECRET` variables when `daemon_only` is
false. If it is absent, the old environment-based configuration still works.

Only one local process connects to a given App ID. The plugin reserves a
deterministic loopback TCP port before starting the Lark WebSocket; duplicate
instances wait and retry. The operating system releases the port when the
owner exits, allowing a standby instance to take over. For port conflicts,
set `instance_port` (1–65535) in the bot profile; set `instance_retry_ms`
(100–60000, default 2000) to adjust the retry period. Instances that use the
same App ID must use the same port. Check stderr for `selected Lark bot`,
`acquired bot port`, and `port ... is occupied` when troubleshooting.

For a step-by-step tour of the source, see [the Chinese code reading guide](docs/code-reading-guide.zh-CN.md).

### Legacy single-bot configuration

The repository is a native CodeBuddy plugin. Settings are declared through
top-level `userConfig`; the App Secret is marked sensitive and is stored outside
the plugin files. Local development can still read the ignored `.env` beside the
bundle.

#### Where legacy configuration lives

CodeBuddy does **not** prompt for `userConfig` values when a plugin is installed
or enabled (verified against 2.142.0: the write path `savePluginOptions()` is
never called). Values have to be written manually — run `/lark-setup` and let
CodeBuddy ask for them and store them for you, or write them yourself:

| Kind | File | Location |
| --- | --- | --- |
| non-sensitive | `~/.codebuddy/settings.json` | `pluginConfigs["<plugin-id>"].options` |
| sensitive (`app_secret`) | `~/.codebuddy/credentials.json` | `pluginSecrets["<plugin-id>"]` |

`<plugin-id>` is `<plugin name>@<marketplace name>`, e.g.
`codebuddy-lark-channel@codebuddy-lark-plugin`. CodeBuddy exports every stored
option to the MCP server process as `CODEBUDDY_PLUGIN_OPTION_<KEY>`, which is
what the runtime reads.

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
// ~/.codebuddy/credentials.json   (chmod 600)
{
  "pluginSecrets": {
    "codebuddy-lark-channel@codebuddy-lark-plugin": {
      "app_secret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
    }
  }
}
```

Options are read when the plugin loads, so restart CodeBuddy (or run
`/reload-plugins`) afterwards.

> A stdio MCP child does not automatically inherit every shell variable, but
> this plugin also reads `~/.codebuddy/.env` itself (see `loadDotenv()` in
> `src/index.ts`). The shared `lark-channel.json` file takes precedence over
> legacy App ID and Secret variables from any `.env` location.

For local development, validate and load the plugin directory:

```bash
codebuddy plugin validate .
codebuddy --plugin-dir . --dangerously-load-development-channels plugin:codebuddy-lark-channel
```

The checked-in bundle at `dist/index.cjs` means users do not need to install Node
dependencies after the plugin has been packaged. Inline development plugins use
`.env`; installed plugins read the stored options described above.

## Package and publish

Build a credential-free release archive:

```bash
npm ci
npm run package:plugin
tar -tzf release/codebuddy-lark-plugin.tgz
```

The archive is written to `release/codebuddy-lark-plugin.tgz`. It excludes
`.env`, `.git`, `node_modules`, local media, source maps, and the release folder.

For team/community distribution, push this repository to GitHub or another Git
host. The repository includes `.codebuddy-plugin/marketplace.json`, so users can
install it as a marketplace:

```bash
codebuddy plugin marketplace add OWNER/REPOSITORY
codebuddy plugin install codebuddy-lark-channel@codebuddy-lark-plugin
```

For a local publication test:

```bash
codebuddy plugin marketplace add /absolute/path/to/codebuddy-lark-plugin
codebuddy plugin install codebuddy-lark-channel@codebuddy-lark-plugin --scope local
```

After installation, run `/lark-setup` (provided by this plugin as
`codebuddy-lark-channel:lark-setup`). It asks for the values below and writes
them to the shared bot file by default:

- `app_id`
- `app_secret` (sensitive)
- `allowed_senders`
- `domain`
- `group_chat_enabled`
- `image_download`
- `allow_all`

For the legacy settings-based flow, the runtime receives values as
`CODEBUDDY_PLUGIN_OPTION_*` environment variables. Explicit `LARK_*` values
take precedence when no shared bot file exists.

You can alternatively load the channel directly as an MCP server.
If the shared bot file exists, select a profile from it with `--lark-bot` in
the server's `args` instead of repeating credentials in the `env` block.

### Direct MCP server in `~/.codebuddy/.mcp.json`

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

### Development without rebuild (tsx)

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
| `HTTP_PROXY` / `HTTPS_PROXY` | no | _unset_ | Proxy for outbound HTTP(S) (e.g. corporate network). Read by axios / node's HTTPS agent. |
| `NO_PROXY` | no | _unset_ | Comma-separated host suffixes that bypass the proxy. |
| `NODE_TLS_REJECT_UNAUTHORIZED` | no | `1` | Set to `0` only if your proxy performs TLS interception with a private CA. |

### `.env` search order

The plugin searches for `.env` in this order; the first existing file wins:

1. `<cwd>/.env` — workspace-level (where you ran CodeBuddy from)
2. `<cwd>/../.env`
3. `<plugin bundle>/../.env` — next to `dist/`
4. `~/.codebuddy/.env` — user-level, survives workspace changes
5. `~/.codebuddy/plugins/data/codebuddy-lark-channel/.env` — plugin data dir, survives reinstalls

A line like `loaded 7 var(s) from /home/user/.codebuddy/.env` on stderr tells you which file the plugin actually used.

### Corporate proxy / MITM

If you are behind an HTTP proxy that must be used to reach Lark/Feishu, set the standard env vars in your `.env`:

```bash
HTTP_PROXY=http://proxy.corp.example.com:8080
HTTPS_PROXY=http://proxy.corp.example.com:8080
NO_PROXY=localhost,127.0.0.1,.corp.example.com
```

If your proxy performs TLS interception with a private CA, Node will reject the cert chain. To accept your corporate MITM appliance (only if you trust the operator):

```bash
NODE_TLS_REJECT_UNAUTHORIZED=0
```

Note: a known esbuild packaging quirk can bundle `https-proxy-agent`'s ES6 class where axios calls it as a function, which throws and breaks the WebSocket connection. This repo defends against it in two layers:

1. `build.mjs` aliases `https-proxy-agent` → `https-proxy-agent/dist/index.js` so only the factory is bundled.
2. `scripts/patch-dist.mjs` runs as part of `npm run build` and `postinstall`; if a stale `dist/index.cjs` still has the buggy pattern, it is auto-patched in place. Run `node scripts/patch-dist.mjs --check` to verify.

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
- `src/instance-config.ts` — selects a bot from the shared instance bindings
- `src/local-bot-leader.ts` — keeps one local WebSocket owner per bot
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
- Outbound replies are restricted to chats that have already produced an authenticated inbound message.
- Duplicate event deliveries are ignored by `message_id`.
- Only pair trusted users: paired users can also approve/deny tool calls via permission relay.

## License

MIT
