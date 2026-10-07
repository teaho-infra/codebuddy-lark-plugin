/**
 * Corporate proxy support.
 *
 * Motivated by environments where outbound traffic to open.feishu.cn /
 * open.larksuite.com must go through an HTTP(S) proxy (e.g.
 * `proxy-intlho.wal-mart.com:8080`) and the proxy performs TLS interception
 * with a private CA, which Node rejects by default.
 *
 * The plugin can be told about the proxy through (first match wins):
 *   1. the `proxy` plugin option / LARK_PROXY env var
 *      (settings.json pluginConfigs options, exported as
 *      CODEBUDDY_PLUGIN_OPTION_PROXY, or a bot profile field in
 *      lark-channel.json)
 *   2. a full URL in HTTPS_PROXY / HTTP_PROXY / ALL_PROXY
 *      (set before the process starts, e.g. in ~/.codebuddy/.env)
 *
 * When a proxy is configured, this module:
 *   - normalizes HTTP_PROXY / HTTPS_PROXY so axios-based SDK requests use it
 *   - sets NODE_TLS_REJECT_UNAUTHORIZED=0 unless NODE_TLS_REJECT_UNAUTHORIZED
 *     is already 1/0 explicitly (corporate MITM certificates would otherwise
 *     be rejected). Only do this when the user actually opted into a proxy.
 *   - sets the undici global dispatcher (Node's global `fetch`) when undici
 *     is resolvable, so fetch-based code paths use the same proxy.
 *
 * The WS long-connection itself needs an explicit `agent`; that is wired in
 * lark-bridge.ts via https-proxy-agent, which reads the same env vars.
 */

export interface ProxySettings {
  /** Normalized proxy URL (always absolute with a scheme). */
  proxyUrl: string;
  /** Whether TLS validation was disabled for this process. */
  tlsDisabled: boolean;
}

const DEFAULT_PROXY = 'http://proxy-intlho.wal-mart.com:8080';

/** Whether NODE_TLS_REJECT_UNAUTHORIZED was already set explicitly. */
function tlsExplicitlySet(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ||
    env.NODE_TLS_REJECT_UNAUTHORIZED === '1';
}

/** Accept bare host:port and normalize to an http:// URL. */
function normalizeProxyUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  // host:port (e.g. proxy-intlho.wal-mart.com:8080)
  if (/^[a-z0-9._-]+:\d+$/i.test(value)) return `http://${value}`;
  // socks proxies are not supported by https-proxy-agent here
  if (/^socks/i.test(value)) return null;
  return null;
}

/**
 * Resolve the proxy URL from env / plugin options. Returns null when no proxy
 * should be used (direct connection).
 *
 * `explicit` (e.g. a bot profile's `proxy` field or the resolved plugin
 * option) takes precedence over environment variables. An empty explicit
 * value means "explicitly no proxy".
 */
export function resolveProxyUrl(
  env: NodeJS.ProcessEnv = process.env,
  explicit?: string,
): string | null {
  // 1. Explicit value passed by the caller (bot profile / plugin option
  //    LARK_PROXY / CODEBUDDY_PLUGIN_OPTION_PROXY).
  if (explicit !== undefined) {
    if (explicit === '') return null;
    return normalizeProxyUrl(explicit);
  }

  // 2. Standard env vars (set in .env or the spawning environment).
  const fromEnv = env.HTTPS_PROXY || env.https_proxy ||
    env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy;
  if (fromEnv) return normalizeProxyUrl(fromEnv);

  // 3. Corporate default (mirrors the reference implementation).
  return DEFAULT_PROXY;
}

/**
 * Apply the proxy to the process environment and global fetch dispatcher.
 * Must run before any outbound network call.
 *
 * Accepts an injected `undici` loader so tests can stub it; the default tries
 * a dynamic import of 'undici' (not bundled) and silently skips when
 * unavailable.
 */
export async function configureProxy(options: {
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  /** Explicit proxy from the resolved bot config (profile field or plugin option). */
  proxyUrl?: string;
  loadUndici?: () => Promise<{ ProxyAgent: unknown; setGlobalDispatcher: (d: unknown) => void } | null>;
} = {}): Promise<ProxySettings | null> {
  const env = options.env ?? process.env;
  const log = options.log ?? (() => {});
  const proxyUrl = resolveProxyUrl(env, options.proxyUrl);
  if (!proxyUrl) {
    log('no proxy configured; using direct connection');
    return null;
  }

  // Corporate proxies typically do SSL inspection with a self-signed cert
  // chain. Disable Node's cert validation only when the user has not already
  // made an explicit choice.
  const tlsDisabled = !tlsExplicitlySet(env);
  if (tlsDisabled) {
    env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }

  // Set env vars so the axios-based SDK requests pick up the proxy
  // automatically.
  env.HTTPS_PROXY = proxyUrl;
  env.HTTP_PROXY = proxyUrl;

  // Route Node's global fetch (undici) through the proxy too, when undici is
  // resolvable at runtime.
  const loadUndici = options.loadUndici ?? (async () => {
    try {
      return await import('undici');
    } catch {
      return null;
    }
  });
  const undici = await loadUndici();
  if (undici && typeof (undici as { ProxyAgent?: unknown }).ProxyAgent === 'function') {
    const agent = new (undici as new (url: string) => unknown).ProxyAgent(proxyUrl);
    (undici as { setGlobalDispatcher: (d: unknown) => void }).setGlobalDispatcher(agent);
  }

  log(
    `using proxy ${proxyUrl}` +
      (tlsDisabled ? ' (NODE_TLS_REJECT_UNAUTHORIZED=0 for corp MITM cert)' : ''),
  );
  return { proxyUrl, tlsDisabled };
}
