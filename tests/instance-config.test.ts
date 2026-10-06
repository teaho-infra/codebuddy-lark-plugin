import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadRuntimeConfig } from '../src/instance-config.js';

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'lark-config-'));
  const dir = join(home, '.codebuddy');
  await mkdir(dir);
  await writeFile(join(dir, 'lark-channel.json'), JSON.stringify({
    version: 1,
    bots: {
      daemon: { app_id: 'cli_daemon', app_secret: 'daemon-secret' },
      project: { app_id: 'cli_project', app_secret: 'project-secret', instance_port: 34567, instance_retry_ms: 750 },
    },
    bindings: {
      session_ids: { chosen: 'project' },
      session_kinds: { daemon: 'daemon' },
      workspaces: { '/work/project': 'project' },
    },
  }));
  return home;
}

test('session id binding takes precedence over daemon and workspace bindings', async () => {
  const home = await fixture();
  const selected = await loadRuntimeConfig({
    home,
    cwd: '/work/project',
    env: { CODEBUDDY_SESSION_ID: 'chosen', CODEBUDDY_SESSION_KIND: 'daemon' },
  });
  assert.equal(selected.botName, 'project');
  assert.equal(selected.config?.appId, 'cli_project');
  assert.equal(selected.config?.instancePort, 34567);
  assert.equal(selected.config?.instanceRetryMs, 750);
});

test('daemon binding is selected when no more specific binding matches', async () => {
  const home = await fixture();
  const selected = await loadRuntimeConfig({
    home,
    cwd: '/other',
    env: { CODEBUDDY_SESSION_KIND: 'daemon' },
  });
  assert.equal(selected.botName, 'daemon');
});

test('workspace binding uses CodeBuddy project directory when child cwd differs', async () => {
  const home = await fixture();
  const selected = await loadRuntimeConfig({
    home,
    cwd: '/other',
    env: { CODEBUDDY_PROJECT_DIR: '/work/project' },
  });
  assert.equal(selected.botName, 'project');
});

test('command line bot selection overrides bindings', async () => {
  const home = await fixture();
  const selected = await loadRuntimeConfig({
    home,
    cwd: '/other',
    env: { CODEBUDDY_SESSION_KIND: 'daemon' },
    argv: ['--lark-bot', 'project'],
  });
  assert.equal(selected.botName, 'project');
});

test('per-process plugin bot option overrides bindings and old credential env', async () => {
  const home = await fixture();
  const selected = await loadRuntimeConfig({
    home,
    cwd: '/other',
    env: {
      CODEBUDDY_SESSION_KIND: 'daemon',
      CODEBUDDY_PLUGIN_OPTION_BOT: 'project',
      LARK_APP_ID: 'cli_wrong',
      LARK_APP_SECRET: 'wrong-secret',
    },
  });
  assert.equal(selected.botName, 'project');
  assert.equal(selected.config?.appId, 'cli_project');
});

test('an explicit bot needs a central config file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'lark-config-'));
  await assert.rejects(
    loadRuntimeConfig({ home, cwd: '/other', env: {}, argv: ['--lark-bot', 'project'] }),
    /requires a bot configuration file/,
  );
});

test('unmatched instance does not connect to any bot', async () => {
  const home = await fixture();
  const selected = await loadRuntimeConfig({ home, cwd: '/other', env: {} });
  assert.equal(selected.botName, null);
  assert.equal(selected.config, null);
});

test('legacy environment configuration works without the central file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'lark-config-'));
  const selected = await loadRuntimeConfig({
    home,
    cwd: '/other',
    env: { LARK_APP_ID: 'cli_legacy', LARK_APP_SECRET: 'legacy-secret' },
  });
  assert.equal(selected.botName, 'legacy');
  assert.equal(selected.config?.appId, 'cli_legacy');
});

test('CODEBUDDY_CONFIG_DIR moves the shared bot file', async () => {
  const home = await fixture();
  const selected = await loadRuntimeConfig({
    home: '/unused-home',
    cwd: '/other',
    env: {
      CODEBUDDY_CONFIG_DIR: join(home, '.codebuddy'),
      CODEBUDDY_SESSION_KIND: 'daemon',
    },
  });
  assert.equal(selected.botName, 'daemon');
});

test('daemon_only excludes an ordinary session even when a shared bot file matches', async () => {
  const home = await fixture();
  const selected = await loadRuntimeConfig({
    home,
    cwd: '/work/project',
    env: {
      CODEBUDDY_SESSION_ID: 'chosen',
      CODEBUDDY_SESSION_KIND: 'interactive',
      CODEBUDDY_PLUGIN_OPTION_DAEMON_ONLY: 'true',
    },
  });
  assert.equal(selected.botName, null);
  assert.equal(selected.config, null);
  assert.match(selected.source, /daemon_only/);
});

test('daemon_only uses settings credentials on daemon and ignores shared bot file', async () => {
  const home = await fixture();
  const selected = await loadRuntimeConfig({
    home,
    cwd: '/work/project',
    env: {
      CODEBUDDY_SESSION_KIND: 'daemon',
      CODEBUDDY_PLUGIN_OPTION_DAEMON_ONLY: 'true',
      CODEBUDDY_PLUGIN_OPTION_APP_ID: 'cli_settings',
      CODEBUDDY_PLUGIN_OPTION_APP_SECRET: 'settings-secret',
      CODEBUDDY_PLUGIN_OPTION_ALLOWED_SENDERS: 'ou_settings',
      LARK_APP_ID: 'cli_old_env',
      LARK_APP_SECRET: 'old-env-secret',
      LARK_ALLOWED_SENDERS: 'ou_old_env',
    },
  });
  assert.equal(selected.botName, 'legacy');
  assert.equal(selected.config?.appId, 'cli_settings');
  assert.deepEqual(selected.config?.allowedSenders, ['ou_settings']);
  assert.equal(selected.configPath, null);
});

test('daemon_only fails closed when the session kind is unknown', async () => {
  const home = await mkdtemp(join(tmpdir(), 'lark-config-'));
  const selected = await loadRuntimeConfig({
    home,
    cwd: '/other',
    env: { CODEBUDDY_PLUGIN_OPTION_DAEMON_ONLY: 'true' },
  });
  assert.equal(selected.config, null);
  assert.match(selected.source, /kind=unknown/);
});

test('daemon_only rejects a misspelled value', async () => {
  const home = await mkdtemp(join(tmpdir(), 'lark-config-'));
  await assert.rejects(
    loadRuntimeConfig({
      home,
      cwd: '/other',
      env: { CODEBUDDY_PLUGIN_OPTION_DAEMON_ONLY: 'ture' },
    }),
    /daemon_only must be true or false/,
  );
});
