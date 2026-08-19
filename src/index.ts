#!/usr/bin/env node
import { loadConfig } from './config.js';
import { LarkBridge } from './lark-bridge.js';
import { ChannelServer } from './channel-server.js';

// All logs MUST go to stderr. stdout is reserved for the MCP JSON-RPC framing.
function log(line: string): void {
  process.stderr.write(`${new Date().toISOString()} ${line}\n`);
}

async function main(): Promise<void> {
  // Minimal .env loader (no extra dependency). Parses KEY=VALUE lines.
  await loadDotenv();

  const config = loadConfig(process.env);

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

  // Then connect to Lark.
  await bridge.start();

  log('codebuddy-lark-channel ready');
}

async function loadDotenv(): Promise<void> {
  try {
    const { readFile } = await import('node:fs/promises');
    const { dirname, resolve } = await import('node:path');
    // CodeBuddy starts MCP servers with the workspace as cwd. Also search next
    // to the bundle so a local plugin can reliably use its own ignored .env.
    const moduleDir = dirname(resolve(process.argv[1] || '.'));
    const candidates = [
      resolve(process.cwd(), '.env'),
      resolve(process.cwd(), '../.env'),
      resolve(moduleDir, '../.env'),
    ];
    for (const path of candidates) {
      let raw: string;
      try {
        raw = await readFile(path, 'utf8');
      } catch {
        continue;
      }
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
        if (!(key in process.env)) process.env[key] = value;
      }
      break;
    }
  } catch {
    // ignore
  }
}

main().catch((err) => {
  log(`fatal: ${(err as Error).stack || (err as Error).message}`);
  process.exit(1);
});
