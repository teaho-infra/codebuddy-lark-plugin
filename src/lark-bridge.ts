import * as lark from '@larksuiteoapi/node-sdk';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { Config } from './config.js';

export interface InboundMessage {
  /** Sender open_id (the real person, never the chat). */
  senderId: string;
  /** Chat id (p2p or group). Used as chat_id for replies. */
  chatId: string;
  /** p2p | group */
  chatType: 'p2p' | 'group';
  /** Original message id. */
  messageId: string;
  /** Plain text content (already flattened). */
  text: string;
  /** Message type: text, image, file, etc. */
  messageType: string;
  /** Optional local file path if a media file was downloaded. */
  attachmentPath?: string;
}

export interface OutboundMessage {
  chatId: string;
  text: string;
}

interface MessageReceiveEvent {
  sender?: { sender_id?: { open_id?: string } };
  message?: {
    chat_id?: string;
    chat_type?: string;
    message_id?: string;
    message_type?: string;
    content?: string;
    mentions?: Array<{ key?: string; name?: string }>;
  };
}

/** Permission reply shape: "y|yes|n|no <5-char id>" */
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;
const MAX_LARK_TEXT_CHARS = 20_000;
const MAX_SEEN_MESSAGE_IDS = 2_000;

/**
 * Inspect the local environment for common reasons a long-connection to
 * `open.feishu.cn` (or `open.larksuite.com`) cannot be established, and
 * return a one-line, sanitized diagnostic for the user. The error message
 * from the SDK only contains the SDK-side string; we re-derive likely root
 * causes from env so a user in a corporate network can immediately tell
 * whether the problem is proxy, TLS, or DNS.
 *
 * This is intentionally heuristic. We do not run network probes; we only
 * summarize what the process can already see.
 */
function diagnoseConnectFailure(err: Error): string {
  const lines: string[] = [];
  const env = process.env;

  // Proxy detection — note we hide credentials embedded in URLs.
  const proxyVars = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
  const proxies = proxyVars
    .map((k) => [k, env[k]] as const)
    .filter(([, v]) => typeof v === 'string' && v.length > 0);
  if (proxies.length > 0) {
    lines.push(
      'proxy env detected: ' +
        proxies.map(([k, v]) => `${k}=${sanitizeProxyUrl(v as string)}`).join(', '),
    );
  } else {
    lines.push('no HTTPS_PROXY/HTTP_PROXY set — outbound uses direct connect');
  }
  const noProxy = env.NO_PROXY || env.no_proxy;
  if (noProxy) lines.push(`NO_PROXY=${noProxy}`);

  // TLS — corp MITM appliances typically need this.
  const tlsReject = env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (tlsReject === '0') {
    lines.push('NODE_TLS_REJECT_UNAUTHORIZED=0 (TLS cert validation disabled — required for some corp MITM proxies)');
  } else {
    lines.push(
      'NODE_TLS_REJECT_UNAUTHORIZED=' + (tlsReject ?? '1') +
        ' (TLS certs are validated; corporate MITM proxies will fail here)',
    );
  }

  // Heuristic hint from the SDK error message — the SDK tends to surface
  // these substrings.
  const msg = err.message.toLowerCase();
  if (msg.includes('enotfound') || msg.includes('getaddrinfo') || msg.includes('eai_again')) {
    lines.push('hint: looks like DNS — verify network/DNS or that proxy host resolves');
  } else if (msg.includes('econnrefused')) {
    lines.push('hint: TCP refused — proxy may be down, port blocked, or wrong scheme (http vs https)');
  } else if (msg.includes('etimedout') || msg.includes('timeout')) {
    lines.push('hint: TCP/WS timeout — proxy may be slow or blocking the WS upgrade');
  } else if (msg.includes('unable_to_verify_leaf_signature') || msg.includes('cert') || msg.includes('unable_to_get_issuer')) {
    lines.push('hint: TLS cert chain rejected — set NODE_TLS_REJECT_UNAUTHORIZED=0 if your proxy performs TLS interception');
  } else if (msg.includes('unauthorized') || msg.includes('forbidden') || msg.includes('401') || msg.includes('403')) {
    lines.push('hint: auth — double-check LARK_APP_ID and LARK_APP_SECRET are correct for your bot');
  } else if (msg.includes('pullconnectconfig failed')) {
    lines.push('hint: SDK could not fetch the WS endpoint — usually network/proxy/TLS, see above');
  } else if (msg.includes('exhausted')) {
    lines.push('hint: SDK gave up reconnecting — likely a permanent network/proxy/auth issue');
  }

  return lines.join(' | ');
}

/** Strip userinfo from a proxy URL like http://user:pass@host:port -> http://host:port. */
function sanitizeProxyUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.username || u.password) {
      u.username = '***';
      u.password = '***';
    }
    return u.toString();
  } catch {
    // Unparseable — return as-is but truncated.
    return raw.length > 64 ? raw.slice(0, 64) + '…' : raw;
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface PermissionDecision {
  requestId: string;
  behavior: 'allow' | 'deny';
}

/**
 * Bridges Lark/Feishu bot events to plain callbacks.
 * Uses the long-connection (WS) event dispatcher so no public callback URL is needed.
 */
export class LarkBridge {
  private readonly client: lark.Client;
  private readonly wsClient: lark.WSClient;
  private readonly mediaDirAbs: string;
  private readonly seenMessageIds = new Set<string>();
  private readonly stderrLogger: {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    trace: (...args: unknown[]) => void;
    fatal: (...args: unknown[]) => void;
  };

  constructor(
    private readonly config: Config,
    private readonly handlers: {
      onMessage: (msg: InboundMessage) => void | Promise<void>;
      onPermission?: (decision: PermissionDecision) => void | Promise<void>;
      log?: (line: string) => void;
    },
  ) {
    // IMPORTANT: the SDK's defaultLogger writes to console.log (stdout).
    // stdout is reserved for MCP framing, so route all SDK logs to stderr.
    this.stderrLogger = {
      debug: (...args: unknown[]) => this.sdkLog('debug', args),
      info: (...args: unknown[]) => this.sdkLog('info', args),
      warn: (...args: unknown[]) => this.sdkLog('warn', args),
      error: (...args: unknown[]) => this.sdkLog('error', args),
      trace: (...args: unknown[]) => this.sdkLog('trace', args),
      fatal: (...args: unknown[]) => this.sdkLog('fatal', args),
    };

    this.client = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      domain: config.domain,
      loggerLevel: lark.LoggerLevel.warn,
      logger: this.stderrLogger,
    });

    // Resolve the proxy for the WS transport once. config.proxy comes from
    // the bot profile / plugin option; otherwise fall back to env vars set by
    // configureProxy() (which itself defaults HTTPS_PROXY/HTTP_PROXY).
    const wsProxyRaw = config.proxy ||
      process.env.HTTPS_PROXY || process.env.https_proxy ||
      process.env.HTTP_PROXY || process.env.http_proxy;
    let wsProxyAgent: HttpsProxyAgent<string> | undefined;
    if (wsProxyRaw && wsProxyRaw.trim() !== '') {
      const normalized = /^https?:\/\//i.test(wsProxyRaw.trim())
        ? wsProxyRaw.trim()
        : `http://${wsProxyRaw.trim()}`;
      try {
        wsProxyAgent = new HttpsProxyAgent(normalized);
      } catch (err) {
        this.log(`proxy agent construction failed: ${(err as Error).message}; WS will connect directly`);
      }
    }

    this.wsClient = new lark.WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      domain: config.domain,
      loggerLevel: lark.LoggerLevel.warn,
      logger: this.stderrLogger,
      // The `ws` package does NOT honor HTTPS_PROXY/HTTP_PROXY env vars, so
      // the WebSocket long-connection must be routed through an explicit
      // http(s) agent. https-proxy-agent reads the proxy URL from env (set by
      // src/proxy.ts configureProxy(), a LARK_PROXY plugin option, or the
      // user's own HTTPS_PROXY). Without a proxy configured, we pass no agent
      // and ws connects directly.
      ...(wsProxyAgent ? { agent: wsProxyAgent } : {}),
      // Surface the SDK's internal connection state machine so the user can
      // see *why* the WebSocket is not coming up. The SDK already logs these
      // events through the redirected logger above; the callbacks add
      // timestamps + structured prefixes that are easy to grep in stderr.
      onReady: () => {
        this.log('connection ready (long-connection established)');
      },
      onError: (err) => {
        // `err` from the SDK is always `new Error(string)` — the SDK throws
        // away the original axios/Undici error. Diagnose here using env so
        // the user can see whether proxy/TLS is the likely culprit without
        // re-running with NODE_DEBUG=net,https.
        const detail = diagnoseConnectFailure(err);
        this.log(`connection failed: ${err.message}`);
        if (detail) this.log(`diagnostics: ${detail}`);
      },
      onReconnecting: () => {
        this.log('connection lost, reconnecting (will retry with backoff)');
      },
      onReconnected: () => {
        this.log('connection re-established after a previous drop');
      },
    });

    this.mediaDirAbs = resolve(config.mediaDir);
  }

  private log(line: string) {
    this.handlers.log?.(`[lark] ${line}`);
  }

  private sdkLog(level: string, args: unknown[]) {
    // Surface warn/error/fatal always, and also `info` for the SDK's `[ws]`
    // channel so the user can see reconnect attempts / handshake state.
    // The default info level is filtered out because the SDK is otherwise
    // very chatty on every API call.
    const isImportantWs =
      level === 'info' &&
      args.some(
        (a) => typeof a === 'string' && (a.startsWith('[ws]') || a.includes('ws ')),
      );
    if (level === 'warn' || level === 'error' || level === 'fatal' || isImportantWs) {
      const text = args
        .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
        .join(' ');
      this.handlers.log?.(`[lark-sdk:${level}] ${text}`);
    }
  }

  /** Whether a sender is allowed to push messages into the CodeBuddy session. */
  isSenderAllowed(openId: string): boolean {
    if (this.config.allowAllSenders) return true;
    return this.config.allowedSenders.includes(openId);
  }

  async start(): Promise<void> {
    await mkdir(this.mediaDirAbs, { recursive: true });

    const eventDispatcher = new lark.EventDispatcher({
      loggerLevel: lark.LoggerLevel.warn,
      logger: this.stderrLogger,
    }).register({
      // IM message receive event (v2 schema).
      'im.message.receive_v1': async (data) => {
        try {
          await this.handleReceiveEvent(data);
        } catch (err) {
          this.log(`handleReceiveEvent error: ${(err as Error).message}`);
        }
        return {};
      },
    });

    this.log(`connecting to ${this.config.domain} (long-connection WS)...`);
    const startedAt = Date.now();
    try {
      await this.wsClient.start({ eventDispatcher });
    } catch (err) {
      // wsClient.start() can throw synchronously if construction failed (we
      // catch that above in the ctor). It can also throw if the first
      // connect attempt rejects before onError fires (rare). Always log +
      // diagnose here, otherwise the failure is silent and the user only
      // sees "long-connection (WS) event client started" never appear.
      const e = err as Error;
      this.log(`start() threw after ${Date.now() - startedAt}ms: ${e.message}`);
      const detail = diagnoseConnectFailure(e);
      if (detail) this.log(`diagnostics: ${detail}`);
      throw err;
    }
    this.log(`long-connection (WS) event client started in ${Date.now() - startedAt}ms`);
  }

  private async handleReceiveEvent(
    data: MessageReceiveEvent,
  ): Promise<void> {
    const senderId = data.sender?.sender_id?.open_id || '';
    const chatId = data.message?.chat_id || '';
    const chatType = (data.message?.chat_type as 'p2p' | 'group') || 'p2p';
    const messageId = data.message?.message_id || '';
    const messageType = data.message?.message_type || 'text';

    if (!senderId || !chatId || !messageId) {
      this.log('dropping malformed message event (missing sender/chat/message id)');
      return;
    }

    // Lark retries events when acknowledgements are delayed. Avoid injecting
    // the same prompt twice while keeping the cache bounded for long runtimes.
    if (this.seenMessageIds.has(messageId)) {
      this.log(`dropping duplicate message ${messageId}`);
      return;
    }
    this.seenMessageIds.add(messageId);
    if (this.seenMessageIds.size > MAX_SEEN_MESSAGE_IDS) {
      const oldest = this.seenMessageIds.values().next().value as string | undefined;
      if (oldest) this.seenMessageIds.delete(oldest);
    }

    // Permission decision replies are allowed even for non-allowlisted? No —
    // only allowlisted trusted users may decide permissions.
    if (!this.isSenderAllowed(senderId)) {
      this.log(`dropping message from unlisted sender ${senderId}`);
      return;
    }

    if (chatType === 'group' && !this.config.groupChatEnabled) {
      this.log('dropping group-chat message (LARK_GROUP_CHAT_ENABLED off)');
      return;
    }

    // Parse text.
    let text = '';
    let attachmentPath: string | undefined;

    if (messageType === 'text') {
      text = this.extractText(data.message?.content);
      text = this.removeBotMentions(text, data.message?.mentions);
    } else if (messageType === 'post') {
      text = this.extractPostText(data.message?.content);
    } else if (messageType === 'image' && this.config.imageDownloadEnabled) {
      const imageKey = this.extractImageKey(data.message?.content);
      if (imageKey) {
        attachmentPath = await this.downloadImage(imageKey, messageId);
        text = `[image] ${attachmentPath}`;
      } else {
        text = '[image]';
      }
    } else if (messageType === 'file') {
      // Could download via im.file resources / im.message.resource; keep as marker for now.
      text = this.extractText(data.message?.content) || '[file]';
    } else {
      text = `[unsupported message type: ${messageType}]`;
    }

    // Intercept permission decisions: "yes abcde" / "no abcde".
    const permMatch = PERMISSION_REPLY_RE.exec(text);
    if (permMatch && this.handlers.onPermission) {
      await this.handlers.onPermission({
        requestId: permMatch[2].toLowerCase(),
        behavior: permMatch[1].toLowerCase().startsWith('y') ? 'allow' : 'deny',
      });
      this.log(`permission decision: ${permMatch[0]}`);
      return;
    }

    await this.handlers.onMessage({
      senderId,
      chatId,
      chatType,
      messageId,
      text,
      messageType,
      attachmentPath,
    });
  }

  private removeBotMentions(
    text: string,
    mentions: Array<{ key?: string; name?: string }> | undefined,
  ): string {
    let result = text;
    for (const mention of mentions || []) {
      if (mention.key) result = result.split(mention.key).join('');
    }
    return result.trim();
  }

  private extractText(contentJson: string | undefined): string {
    if (!contentJson) return '';
    try {
      const obj = JSON.parse(contentJson);
      return String(obj.text || '').trim();
    } catch {
      return '';
    }
  }

  private extractPostText(contentJson: string | undefined): string {
    if (!contentJson) return '';
    try {
      const obj = JSON.parse(contentJson);
      const parts: string[] = [];
      // title
      if (obj.title) parts.push(String(obj.title));
      // content is [[ {tag, text/...}, ... ], ...]
      const blocks = Array.isArray(obj.content) ? obj.content : [];
      for (const line of blocks) {
        if (!Array.isArray(line)) continue;
        for (const node of line) {
          if (node?.tag === 'text' && typeof node.text === 'string') parts.push(node.text);
          else if (node?.tag === 'a' && typeof node.text === 'string')
            parts.push(`${node.text}(${node.href || ''})`);
          else if (node?.tag === 'at' && typeof node.user_name === 'string')
            parts.push(`@${node.user_name}`);
        }
        parts.push('\n');
      }
      return parts.join('').trim();
    } catch {
      return '';
    }
  }

  private extractImageKey(contentJson: string | undefined): string | undefined {
    if (!contentJson) return;
    try {
      const obj = JSON.parse(contentJson);
      return obj.image_key;
    } catch {
      return;
    }
  }

  private async downloadImage(imageKey: string, messageId: string): Promise<string | undefined> {
    try {
      const resp = await this.client.im.messageResource.get({
        path: { message_id: messageId, file_key: imageKey },
        params: { type: 'image' },
      });
      const stream = resp.getReadableStream();
      const ext = '.png';
      const safeId = messageId.replace(/[^a-zA-Z0-9_-]/g, '_') || imageKey.slice(0, 8);
      const filename = `${Date.now()}-${safeId}${ext}`;
      const outPath = resolve(this.mediaDirAbs, filename);
      await new Promise<void>((resolve, reject) => {
        const ws = createWriteStream(outPath);
        stream.pipe(ws);
        stream.on('error', reject);
        ws.on('finish', resolve);
        ws.on('error', reject);
      });
      return outPath;
    } catch (err) {
      this.log(`image download failed: ${(err as Error).message}`);
      return undefined;
    }
  }

  /** Send a text reply to a chat. Called by CodeBuddy via the MCP `reply` tool. */
  async sendText({ chatId, text }: OutboundMessage): Promise<void> {
    if (!chatId) throw new Error('chatId is required');
    if (!text) throw new Error('text is required');
    const chunks = this.splitText(text, MAX_LARK_TEXT_CHARS);
    for (const chunk of chunks) {
      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: chunk }),
        },
      });
    }
    this.log(`sent reply to ${chatId} (${text.length} chars)`);
  }

  private splitText(text: string, maxChars: number): string[] {
    const chars = Array.from(text);
    const chunks: string[] = [];
    for (let start = 0; start < chars.length; start += maxChars) {
      chunks.push(chars.slice(start, start + maxChars).join(''));
    }
    return chunks;
  }

  /** Reply in-thread to the original message (optional, nicer UX in groups). */
  async sendReplyInThread(messageId: string, text: string): Promise<void> {
    await this.client.im.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
  }
}
