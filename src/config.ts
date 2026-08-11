// Configuration loaded from environment variables.
// Copy .env.example to .env and fill in your Lark/Feishu bot credentials.

export interface Config {
  /** App ID of the Lark/Feishu bot (required). */
  appId: string;
  /** App secret (required). */
  appSecret: string;
  /** Lark API domain. Defaults to Feishu (https://open.feishu.cn).
   *  For international Lark use https://open.larksuite.com */
  domain: string;
  /** Comma-separated list of allowed sender open_ids (recommended). */
  allowedSenders: string[];
  /** If true, accept messages from any sender (INSECURE — only for testing). */
  allowAllSenders: boolean;
  /** If true, emit messages from group chats (still subject to sender allowlist). */
  groupChatEnabled: boolean;
  /** If true, also forward image messages as local file references. */
  imageDownloadEnabled: boolean;
  /** Directory used to cache downloaded images/files. */
  mediaDir: string;
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function bool(value: string | undefined, defaultValue = false): boolean {
  if (value === undefined) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const appId = env.LARK_APP_ID || env.FEISHU_APP_ID || '';
  const appSecret = env.LARK_APP_SECRET || env.FEISHU_APP_SECRET || '';

  if (!appId || !appSecret) {
    throw new Error(
      'Missing LARK_APP_ID / LARK_APP_SECRET. Copy .env.example to .env and fill them in.',
    );
  }

  return {
    appId,
    appSecret,
    domain: env.LARK_DOMAIN || 'https://open.feishu.cn',
    allowedSenders: parseList(env.LARK_ALLOWED_SENDERS || env.LARK_ALLOWED_USERS),
    allowAllSenders: bool(env.LARK_ALLOW_ALL, false),
    groupChatEnabled: bool(env.LARK_GROUP_CHAT_ENABLED, false),
    imageDownloadEnabled: bool(env.LARK_IMAGE_DOWNLOAD, true),
    mediaDir: env.LARK_MEDIA_DIR || './.lark-media',
  };
}
