---
description: Collect and store the Lark/Feishu bot credentials for this channel plugin
argument-hint: [app_id] [app_secret]
allowed-tools: Read, Edit, Write, Bash
---

Configure the Lark/Feishu bot that this channel plugin connects to.

CodeBuddy does **not** prompt for `userConfig` values on install (as of
2.142.0), and the plugin's MCP server does **not** inherit `~/.codebuddy/.env`.
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
3. Only if both fail, use `codebuddy-lark-channel@codebuddy-lark-plugins`.

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
        "allow_all": "false"
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

Preserve existing content — this file is shared with OAuth tokens. Then run
`chmod 600 ~/.codebuddy/credentials.json`.

## 5. Finish

Tell the user:

- Restart CodeBuddy (or run `/reload-plugins`), because options are read when
  the plugin loads. Then check `/mcp` — `lark` should be connected.
- If `allowed_senders` is empty, no message is forwarded: DM the bot once, then
  look for `dropping message from unlisted sender ou_...` in
  `~/.codebuddy/logs/<date>/` and add that open_id.
- If startup still fails with `Missing LARK_APP_ID / LARK_APP_SECRET`, re-read
  both files and confirm the plugin id matches.
