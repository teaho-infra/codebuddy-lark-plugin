---
description: Collect and store the Lark/Feishu bot credentials for this channel plugin
argument-hint: [app_id] [app_secret]
allowed-tools: Read, Edit, Write, Bash
---

Configure the Lark/Feishu bot that this channel plugin connects to.

If the user wants **only the daemon** to connect to one bot, use the legacy
settings/credentials flow below and set `daemon_only` to the string `"true"`
in the plugin's `settings.json` options. Do not create a shared
`lark-channel.json` for this case. An existing shared file is ignored when
`daemon_only` is true. Verify the option is present and that `app_secret` is
still stored in `credentials.json`, without printing its value.

## Recommended: shared multi-instance configuration

By default, create or update `~/.codebuddy/lark-channel.json`. This single
file maps CodeBuddy instances to bot profiles, including daemon workers and
ordinary sessions. Ask the user for one value at a time:

1. A short bot name, such as `work` or `daemon-bot`.
2. `app_id`, `app_secret`, and `allowed_senders`; optionally ask for `domain`,
   `group_chat_enabled`, `image_download`, and `allow_all`.
3. Which instance should use it: `session_kinds` (`daemon`, `bg`, or
   `interactive`), `session_ids` (set with `codebuddy --session-id ID`),
   `session_names`, or an exact absolute `workspaces` path. A binding maps the
   chosen value to the bot name. The user may add more bindings later.

Read any existing file and merge into it. Preserve other bot profiles and
bindings. Create the file with this shape, using actual JSON booleans:

```json
{
  "version": 1,
  "bots": {
    "work": {
      "app_id": "cli_...",
      "app_secret": "...",
      "allowed_senders": "ou_..."
    }
  },
  "bindings": {
    "session_ids": { "work-session": "work" }
  }
}
```

Use `$HOME` rather than a literal home path. If `CODEBUDDY_CONFIG_DIR` is set,
put `lark-channel.json` there instead. Do not write credentials into
this repository, an `.env`, or conversation output. After writing the file,
run `chmod 600 <config-dir>/lark-channel.json` on macOS/Linux. Verify that
the file parses as JSON, the chosen bot has non-empty `app_id` and
`app_secret`, and the intended binding points to that bot. Print only bot
names and binding names during verification, never secret values.

Explain that an unmatched instance does not connect to a bot, and an App ID
can have only one local connection at a time. The plugin must be reloaded
after changing the file. `codebuddy daemon start` itself has no
`--mcp-config` flag; use a `session_kinds.daemon` binding to select its bot.

The legacy single-bot configuration below is for users who explicitly want
to keep their existing `settings.json` / `credentials.json` setup. If the
central JSON file exists, it takes precedence over those values unless
`daemon_only` is true.

## Legacy single-bot configuration

CodeBuddy does **not** prompt for `userConfig` values on install (as of
2.142.0). The plugin can read `~/.codebuddy/.env` itself, but this legacy flow
stores plugin options in CodeBuddy's own settings and credentials files.
Credentials must be written to the two files CodeBuddy actually reads:

- non-sensitive options → `~/.codebuddy/settings.json` under
  `pluginConfigs["<plugin-id>"].options`
- sensitive options → `~/.codebuddy/credentials.json` under
  `pluginSecrets["<plugin-id>"]`

CodeBuddy exports every stored option to the MCP server process as
`CODEBUDDY_PLUGIN_OPTION_<KEY>`, which is what the runtime reads.

## 1. Resolve `<plugin-id>`

The id is `<plugin name>@<marketplace name>`. Determine it in this order:

1. Read `~/.codebuddy/plugins/installed_plugins.json` and look for a plugin key
   whose name is `codebuddy-lark-channel`.
2. Otherwise, list `~/.codebuddy/plugins/marketplaces/*/` and find the
   marketplace whose `.codebuddy-plugin/plugin.json` declares
   `"name": "codebuddy-lark-channel"`. The id is
   `codebuddy-lark-channel@<that marketplace directory name>`.
3. Only if both fail, use `codebuddy-lark-channel@codebuddy-lark-plugin`.

Use `$HOME` instead of a literal home path. If `CODEBUDDY_CONFIG_DIR` is set,
read and write under that directory instead of `~/.codebuddy`.

## 2. Collect the values

If `$ARGUMENTS` already contains an app id and app secret, use them and skip
asking. Otherwise ask the user, one question at a time:

| Key | Required | Default | Notes |
| --- | --- | --- | --- |
| `app_id` | yes | — | `cli_...` |
| `app_secret` | yes | — | sensitive |
| `allowed_senders` | no | empty | comma-separated `ou_...` open_ids |
| `domain` | no | `https://open.feishu.cn` | use `https://open.larksuite.com` for Lark (global) |
| `group_chat_enabled` | no | `false` | `true`/`false` |
| `image_download` | no | `true` | `true`/`false` |
| `allow_all` | no | `false` | `true` accepts messages from anyone — prompt-injection risk, testing only |
| `daemon_only` | no | `false` | `true` allows only a CodeBuddy daemon session to connect; ignores `lark-channel.json` |
| `proxy` | no | — | corporate proxy URL or `host:port` (e.g. `http://proxy-intlho.wal-mart.com:8080`). Sets NODE_TLS_REJECT_UNAUTHORIZED=0. Empty string = never proxy |

Store booleans as the strings `"true"` / `"false"`.

**Never echo the app secret back into the conversation**, and never write it into
this repository, `.env`, or any file inside the project directory.

## 3. Write non-sensitive options

Read `~/.codebuddy/settings.json` (create it with `{}` if missing) and merge:

```json
{
  "pluginConfigs": {
    "<plugin-id>": {
      "options": {
        "app_id": "cli_...",
        "allowed_senders": "ou_...",
        "domain": "https://open.feishu.cn",
        "group_chat_enabled": "false",
        "image_download": "true",
        "allow_all": "false",
        "daemon_only": "true"
      }
    }
  }
}
```

Preserve every other top-level key and every other entry inside
`pluginConfigs`. Omit keys the user left at their default.

## 4. Write the sensitive option

Read `~/.codebuddy/credentials.json` (create it with `{}` if missing) and merge:

```json
{
  "pluginSecrets": {
    "<plugin-id>": {
      "app_secret": "..."
    }
  }
}
```

Preserve existing content — this file may be shared with OAuth tokens. Then run
`chmod 600 ~/.codebuddy/credentials.json`.

**Path warning:** the target is `~/.codebuddy/credentials.json` (no leading dot
in the filename). `~/.codebuddy/.credentials.json` is a different file used for
OAuth tokens; CodeBuddy's plugin option loader ignores it. If an older setup
put `pluginSecrets` there, migrate those entries to `credentials.json`.

## 5. Verify

Before telling the user anything, run this check and require it to pass:

```bash
node -e '
const fs=require("fs"),os=require("os"),path=require("path");
const id=process.argv[1];
const opt=JSON.parse(fs.readFileSync(path.join(os.homedir(),".codebuddy/settings.json"),"utf8")).pluginConfigs?.[id]?.options??{};
const credPath=path.join(os.homedir(),".codebuddy/credentials.json");
const sec=fs.existsSync(credPath)?(JSON.parse(fs.readFileSync(credPath,"utf8")).pluginSecrets?.[id]??{}):{};
const merged={...sec,...opt};
const missing=["app_id","app_secret"].filter(k=>!merged[k]);
console.log(missing.length?("MISSING: "+missing.join(", ")):"OK "+JSON.stringify(Object.keys(merged)));
' "<plugin-id>"
```

If it prints `MISSING: app_secret`, you wrote the secret to the wrong file —
fix it per step 4. Do not claim success until it prints `OK`.

## 6. Finish

Tell the user:

- Restart CodeBuddy (or run `/reload-plugins`), because options are read when
  the plugin loads. Then check `/mcp` — `lark` should be connected.
- If `allowed_senders` is empty, no message is forwarded: DM the bot once, then
  look for `dropping message from unlisted sender ou_...` in
  `~/.codebuddy/logs/<date>/` and add that open_id.
- If startup still fails with `Missing LARK_APP_ID / LARK_APP_SECRET`, re-read
  both files and confirm the plugin id matches.
