import * as lark from '@larksuiteoapi/node-sdk';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
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

/** Permission reply shape: "y|yes|n|no <5-char id>" */
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

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
      onMessage: (msg: InboundMessage) => void;
      onPermission?: (decision: PermissionDecision) => void;
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
      // Long-lived client; SDK handles token refresh.
      disableAutoToken: false,
    } as lark.ClientParams);

    this.wsClient = new lark.WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      domain: config.domain,
      loggerLevel: lark.LoggerLevel.warn,
      logger: this.stderrLogger,
    });

    this.mediaDirAbs = resolve(config.mediaDir);
  }

  private log(line: string) {
    this.handlers.log?.(`[lark] ${line}`);
  }

  private sdkLog(level: string, args: unknown[]) {
    // Only surface warn/error from the SDK to keep MCP stderr noise low.
    if (level === 'warn' || level === 'error' || level === 'fatal') {
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

    await this.wsClient.start({ eventDispatcher });
    this.log('long-connection (WS) event client started');
  }

  private async handleReceiveEvent(
    data: lark.EventImMessageReceiveV1,
  ): Promise<void> {
    const senderId = data.sender?.sender_id?.open_id || '';
    const chatId = data.message?.chat_id || '';
    const chatType = (data.message?.chat_type as 'p2p' | 'group') || 'p2p';
    const messageId = data.message?.message_id || '';
    const messageType = data.message?.message_type || 'text';

    if (!senderId) return;

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
      this.handlers.onPermission({
        requestId: permMatch[2].toLowerCase(),
        behavior: permMatch[1].toLowerCase().startsWith('y') ? 'allow' : 'deny',
      });
      this.log(`permission decision: ${permMatch[0]}`);
      return;
    }

    this.handlers.onMessage({
      senderId,
      chatId,
      chatType,
      messageId,
      text,
      messageType,
      attachmentPath,
    });
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
      const resp = await this.client.im.imageResource.get({
        path: { image_key: imageKey },
        params: { type: 'message' },
      });
      // SDK returns a readable stream in resp for binary downloads.
      const stream = (resp as unknown as { data?: NodeJS.ReadableStream })?.data || resp;
      const ext = '.png';
      const safeId = messageId.replace(/[^a-zA-Z0-9_-]/g, '_') || imageKey.slice(0, 8);
      const filename = `${Date.now()}-${safeId}${ext}`;
      const outPath = resolve(this.mediaDirAbs, filename);
      await new Promise<void>((resolve, reject) => {
        const ws = createWriteStream(outPath);
        // @ts-expect-error - SDK returns a request-like/stream object.
        stream.pipe(ws);
        // @ts-expect-error
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
    await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
    this.log(`sent reply to ${chatId} (${text.length} chars)`);
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
