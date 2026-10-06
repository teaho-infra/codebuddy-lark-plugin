import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:net';
import { LocalBotLeader, portForBot } from '../src/local-bot-leader.js';

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('unexpected address');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= until) throw new Error('timed out waiting for leader');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('same bot uses one deterministic port and different bots use different ports', () => {
  assert.equal(portForBot('cli_one'), portForBot('cli_one'));
  assert.notEqual(portForBot('cli_one'), portForBot('cli_two'));
});

test('only one process becomes leader and standby takes over after release', async () => {
  const port = await unusedPort();
  let firstStarts = 0;
  let secondStarts = 0;
  const standbyLogs: string[] = [];
  const first = new LocalBotLeader(port, 20, () => { firstStarts++; });
  const second = new LocalBotLeader(port, 20, () => { secondStarts++; }, (line) => standbyLogs.push(line));
  try {
    await first.start();
    await second.start();
    assert.equal(firstStarts, 1);
    assert.equal(secondStarts, 0);
    await new Promise((resolve) => setTimeout(resolve, 65));
    assert.equal(standbyLogs.filter((line) => line.includes('is occupied')).length, 1);
    await first.stop();
    await waitFor(() => secondStarts === 1);
    assert.equal(firstStarts + secondStarts, 2);
  } finally {
    await first.stop();
    await second.stop();
  }
});
