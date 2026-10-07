#!/usr/bin/env node
import { loadRuntimeConfig } from './instance-config.js';
import { LocalBotLeader, portForBot } from './local-bot-leader.js';
import { LarkBridge } from './lark-bridge.js';
import { ChannelServer } from './channel-server.js';
import { configureProxy } from './proxy.js';

// All logs MUST go to stderr. stdout is reserved for the MCP JSON-RPC framing.
function log(line: string): void {
  process.stderr.write(`${new Date().toISOString()} ${line}\n`);
}

async function main(): Promise<void> {
  // Minimal .env loader (no extra dependency). Parses KEY=VALUE lines.
  await loadDotenv();

  const selection = await loadRuntimeConfig();
  const config = selection.config;

  if (!config) {
    const channel = new ChannelServer(log, false, 'inactive');
    await channel.listen();
    log(`no Lark bot selected (${selection.source}); waiting as an inactive channel`);
    return;
  }
  log(`selected Lark bot ${selection.botName} via ${selection.source}`);

  // Apply corporate proxy settings before any outbound network call: the
  // Lark SDK axios client reads HTTPS_PROXY at request time, and the WS agent
  // below is built from these env vars. config.proxy (bot profile / plugin
  // option) wins over environment variables.
  await configureProxy({ log, proxyUrl: config.proxy });

  if (config.allowAllSenders) {
    log('WARNING: LARK_ALLOW_ALL=true — anyone who can DM the bot can inject messages. For testing only.');
  }
  if (config.allowedSenders.length === 0 && !config.allowAllSenders) {
    log('WARNING: no LARK_ALLOWED_SENDERS configured. No messages will be forwarded until you add senders.');
  }

  const permissionRelayEnabled =
    config.allowedSenders.length > 0 && !config.allowAllSenders;
  const channel = new ChannelServer(log, permissionRelayEnabled);

  const bridge = new LarkBridge(config, {
    onMessage: async (msg) => {
      try {
        await channel.pushMessage(msg);
      } catch (err) {
        log(`pushMessage error: ${(err as Error).message}`);
      }
    },
    onPermission: async (decision) => {
      try {
        await channel.pushPermissionDecision(decision.requestId, decision.behavior);
      } catch (err) {
        log(`pushPermissionDecision error: ${(err as Error).message}`);
      }
    },
    log,
  });

  // Wire the bridge into the channel server's reply tool.
  channel.setBridge(bridge);

  // Start MCP stdio first (CodeBuddy spawns us and waits for the initialize handshake).
  await channel.listen();

  // Only the process holding this bot's loopback port starts a Lark connection.
  // Other CodeBuddy sessions keep their MCP transport alive and retry.
  const port = config.instancePort ?? portForBot(config.appId);
  const leader = new LocalBotLeader(port, config.instanceRetryMs, async () => {
    try {
      await bridge.start();
      log(`codebuddy-lark-channel ready (bot ${selection.botName}, port ${port})`);
    } catch (err) {
      log(`Lark bot ${selection.botName} failed to start: ${(err as Error).message}`);
      process.exit(1);
    }
  }, log);
  await leader.start();
}

async function loadDotenv(): Promise<string | null> {
  try {
    const { readFile, stat } = await import('node:fs/promises');
    const { dirname, resolve } = await import('node:path');
    const { homedir } = await import('node:os');
    // CodeBuddy starts MCP servers with the workspace as cwd. Also search the
    // user's CodeBuddy data dir so a global `.env` works for users who don't
    // keep one in the workspace (common in corporate environments where the
    // workspace is read-only or shared).
    const moduleDir = dirname(resolve(process.argv[1] || '.'));
    const home = homedir();
    const candidates = [
      resolve(process.cwd(), '.env'),
      resolve(process.cwd(), '../.env'),
      resolve(moduleDir, '../.env'),
      // CodeBuddy main config dir (where credentials.json lives).
      resolve(home, '.codebuddy', '.env'),
      // CodeBuddy-managed plugin data dir for this plugin (survives reinstalls).
      resolve(home, '.codebuddy', 'plugins', 'data', 'codebuddy-lark-channel', '.env'),
    ];
    for (const path of candidates) {
      let raw: string;
      try {
        // Skip directories; require a regular file.
        const s = await stat(path);
        if (!s.isFile()) continue;
        raw = await readFile(path, 'utf8');
      } catch {
        continue;
      }
      let loaded = 0;
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        // Process-level configuration always wins. Fill only missing values so
        // an App ID supplied by CodeBuddy does not prevent loading a missing
        // secret (or optional settings) from .env during local development.
        if (!(key in process.env)) {
          process.env[key] = value;
          loaded += 1;
        }
      }
      log(`loaded ${loaded} var(s) from ${path}`);
      return path;
    }
    return null;
  } catch {
    // ignore
    return null;
  }
}

main().catch((err) => {
  log(`fatal: ${(err as Error).stack || (err as Error).message}`);
  process.exit(1);
});
