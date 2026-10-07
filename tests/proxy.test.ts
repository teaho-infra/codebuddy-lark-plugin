import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveProxyUrl, configureProxy } from '../src/proxy.js';

test('resolveProxyUrl falls back to the corporate default', () => {
  assert.equal(resolveProxyUrl({}), 'http://proxy-intlho.wal-mart.com:8080');
});

test('resolveProxyUrl accepts a full URL or bare host:port', () => {
  assert.equal(resolveProxyUrl({}, 'http://p:1'), 'http://p:1');
  assert.equal(resolveProxyUrl({}, 'https://p:1'), 'https://p:1');
  assert.equal(resolveProxyUrl({}, 'proxy.host:8080'), 'http://proxy.host:8080');
});

test('an explicit empty proxy value disables the proxy', () => {
  assert.equal(resolveProxyUrl({}, ''), null);
  // ...and wins over environment variables.
  assert.equal(resolveProxyUrl({ HTTPS_PROXY: 'http://env:3' }, ''), null);
});

test('standard proxy env vars are honored when no explicit value is given', () => {
  assert.equal(resolveProxyUrl({ HTTPS_PROXY: 'http://env:3' }), 'http://env:3');
  assert.equal(resolveProxyUrl({ http_proxy: 'http://env:4' }), 'http://env:4');
});

test('unsupported socks proxies are ignored', () => {
  assert.equal(resolveProxyUrl({ HTTPS_PROXY: 'socks5://x' }), null);
  assert.equal(resolveProxyUrl({}, 'socks5://x'), null);
});

test('configureProxy sets env vars and disables TLS validation', async () => {
  const env: Record<string, string | undefined> = {};
  const result = await configureProxy({
    env,
    loadUndici: async () => null,
    log: () => {},
  });
  assert.ok(result);
  assert.equal(result.proxyUrl, 'http://proxy-intlho.wal-mart.com:8080');
  assert.equal(result.tlsDisabled, true);
  assert.equal(env.HTTPS_PROXY, 'http://proxy-intlho.wal-mart.com:8080');
  assert.equal(env.HTTP_PROXY, 'http://proxy-intlho.wal-mart.com:8080');
  assert.equal(env.NODE_TLS_REJECT_UNAUTHORIZED, '0');
});

test('configureProxy leaves env untouched when the proxy is disabled', async () => {
  const env: Record<string, string | undefined> = {};
  const result = await configureProxy({
    env,
    proxyUrl: '',
    loadUndici: async () => null,
    log: () => {},
  });
  assert.equal(result, null);
  assert.equal(env.HTTPS_PROXY, undefined);
  assert.equal(env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
});

test('configureProxy preserves an explicit NODE_TLS_REJECT_UNAUTHORIZED', async () => {
  const env: Record<string, string | undefined> = { NODE_TLS_REJECT_UNAUTHORIZED: '1' };
  const result = await configureProxy({
    env,
    loadUndici: async () => null,
    log: () => {},
  });
  assert.ok(result);
  assert.equal(result.tlsDisabled, false);
  assert.equal(env.NODE_TLS_REJECT_UNAUTHORIZED, '1');
});

test('configureProxy installs an undici global dispatcher when available', async () => {
  let installed: unknown = null;
  const stub = {
    ProxyAgent: class {
      url: string;
      constructor(url: string) { this.url = url; }
    },
    setGlobalDispatcher: (d: unknown) => { installed = d; },
  };
  const result = await configureProxy({
    env: {},
    proxyUrl: 'http://px:9',
    loadUndici: async () => stub,
    log: () => {},
  });
  assert.ok(result);
  assert.equal(result.proxyUrl, 'http://px:9');
  assert.ok(installed);
  assert.equal((installed as { url: string }).url, 'http://px:9');
});
