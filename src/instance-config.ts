import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { loadConfig, type Config } from './config.js';

interface BotProfile {
  app_id: string;
  app_secret: string;
  domain?: string;
  allowed_senders?: string;
  allow_all?: boolean;
  group_chat_enabled?: boolean;
  image_download?: boolean;
  media_dir?: string;
  instance_port?: number;
  instance_retry_ms?: number;
}

interface BotBindings {
  session_ids?: Record<string, string>;
  session_names?: Record<string, string>;
  workspaces?: Record<string, string>;
  session_kinds?: Record<string, string>;
}

interface BotConfigFile {
  version: 1;
  bots: Record<string, BotProfile>;
  bindings?: BotBindings;
  default_bot?: string;
}

export interface RuntimeSelection {
  botName: string | null;
  config: Config | null;
  source: string;
  configPath: string | null;
}

interface LoadOptions {
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  cwd?: string;
  home?: string;
}

function daemonOnlyEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.CODEBUDDY_PLUGIN_OPTION_DAEMON_ONLY ?? env.LARK_DAEMON_ONLY;
  if (value === undefined || value === '') return false;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  throw new Error('daemon_only must be true or false');
}

function settingsFirstEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const preferred = { ...env };
  for (const option of [
    'APP_ID', 'APP_SECRET', 'DOMAIN', 'ALLOWED_SENDERS', 'ALLOW_ALL',
    'GROUP_CHAT_ENABLED', 'IMAGE_DOWNLOAD', 'INSTANCE_PORT', 'INSTANCE_RETRY_MS',
  ]) {
    const value = env[`CODEBUDDY_PLUGIN_OPTION_${option}`];
    if (value !== undefined && value !== '') preferred[`LARK_${option}`] = value;
  }
  return preferred;
}

function cliValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index >= 0) {
    if (!argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw new Error(`${flag} requires a value`);
    }
    return argv[index + 1];
  }
  const assignment = argv.find((arg) => arg.startsWith(`${flag}=`));
  return assignment?.slice(flag.length + 1);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseConfig(raw: string, path: string): BotConfigFile {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${path}: ${(err as Error).message}`);
  }
  if (!record(value) || value.version !== 1 || !record(value.bots)) {
    throw new Error(`${path} must contain version: 1 and a bots object`);
  }
  if (value.bindings !== undefined && !record(value.bindings)) {
    throw new Error(`${path}: bindings must be an object`);
  }
  return value as unknown as BotConfigFile;
}

function selectBot(file: BotConfigFile, env: NodeJS.ProcessEnv, argv: string[], cwd: string) {
  const explicit = cliValue(argv, '--lark-bot') || env.LARK_BOT ||
    env.CODEBUDDY_PLUGIN_OPTION_BOT;
  if (explicit) return { botName: explicit, source: 'startup option' };

  const bindings = file.bindings || {};
  const sessionId = env.LARK_INSTANCE_ID ||
    env.CODEBUDDY_PLUGIN_OPTION_INSTANCE_ID || env.CODEBUDDY_SESSION_ID;
  if (sessionId && bindings.session_ids?.[sessionId]) {
    return { botName: bindings.session_ids[sessionId], source: `session id ${sessionId}` };
  }
  const sessionName = env.CODEBUDDY_SESSION_NAME;
  if (sessionName && bindings.session_names?.[sessionName]) {
    return { botName: bindings.session_names[sessionName], source: `session name ${sessionName}` };
  }
  const workspace = resolve(env.CODEBUDDY_PROJECT_DIR || env.CLAUDE_PROJECT_DIR || cwd);
  if (bindings.workspaces?.[workspace]) {
    return { botName: bindings.workspaces[workspace], source: `workspace ${workspace}` };
  }
  const sessionKind = env.CODEBUDDY_SESSION_KIND;
  if (sessionKind && bindings.session_kinds?.[sessionKind]) {
    return { botName: bindings.session_kinds[sessionKind], source: `session kind ${sessionKind}` };
  }
  if (file.default_bot) return { botName: file.default_bot, source: 'default bot' };
  return { botName: null, source: 'no matching binding' };
}

function profileEnv(profile: BotProfile, botName: string, configDir: string): NodeJS.ProcessEnv {
  if (!record(profile) || typeof profile.app_id !== 'string' || typeof profile.app_secret !== 'string') {
    throw new Error(`Bot ${botName} needs app_id and app_secret strings`);
  }
  return {
    LARK_APP_ID: profile.app_id,
    LARK_APP_SECRET: profile.app_secret,
    LARK_DOMAIN: profile.domain,
    LARK_ALLOWED_SENDERS: profile.allowed_senders,
    LARK_ALLOW_ALL: String(profile.allow_all ?? false),
    LARK_GROUP_CHAT_ENABLED: String(profile.group_chat_enabled ?? false),
    LARK_IMAGE_DOWNLOAD: String(profile.image_download ?? true),
    LARK_MEDIA_DIR: profile.media_dir
      ? (isAbsolute(profile.media_dir) ? profile.media_dir : resolve(configDir, profile.media_dir))
      : join(configDir, 'lark-media', botName),
    LARK_INSTANCE_PORT: profile.instance_port === undefined ? undefined : String(profile.instance_port),
    LARK_INSTANCE_RETRY_MS: profile.instance_retry_ms === undefined
      ? undefined
      : String(profile.instance_retry_ms),
  };
}

/** Select one bot for this process. An unmatched process remains MCP-only. */
export async function loadRuntimeConfig(options: LoadOptions = {}): Promise<RuntimeSelection> {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv.slice(2);
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  if (daemonOnlyEnabled(env)) {
    const kind = env.CODEBUDDY_SESSION_KIND || 'unknown';
    if (kind !== 'daemon') {
      return { botName: null, config: null, source: `daemon_only (kind=${kind})`, configPath: null };
    }
    return {
      botName: 'legacy',
      config: loadConfig(settingsFirstEnv(env)),
      source: 'daemon_only settings',
      configPath: null,
    };
  }
  const configDir = env.CODEBUDDY_CONFIG_DIR || join(home, '.codebuddy');
  const configPath = cliValue(argv, '--lark-config') || env.LARK_BOT_CONFIG ||
    env.CODEBUDDY_PLUGIN_OPTION_BOT_CONFIG ||
    join(configDir, 'lark-channel.json');
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    if (cliValue(argv, '--lark-config') || env.LARK_BOT_CONFIG ||
      env.CODEBUDDY_PLUGIN_OPTION_BOT_CONFIG) {
      throw new Error(`Bot configuration file not found: ${configPath}`);
    }
    if (cliValue(argv, '--lark-bot') || env.LARK_BOT || env.CODEBUDDY_PLUGIN_OPTION_BOT) {
      throw new Error('Selecting a bot requires a bot configuration file at ~/.codebuddy/lark-channel.json');
    }
    return {
      botName: 'legacy',
      config: loadConfig(env),
      source: 'legacy environment',
      configPath: null,
    };
  }

  const file = parseConfig(raw, configPath);
  const selected = selectBot(file, env, argv, cwd);
  if (!selected.botName) {
    return { botName: null, config: null, source: selected.source, configPath };
  }
  if (!Object.hasOwn(file.bots, selected.botName)) {
    throw new Error(`${configPath}: ${selected.source} selects unknown bot ${selected.botName}`);
  }
  const profile = file.bots[selected.botName];
  return {
    botName: selected.botName,
    config: loadConfig(profileEnv(profile, selected.botName, configDir)),
    source: selected.source,
    configPath,
  };
}
