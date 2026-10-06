import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ChannelServer } from '../src/channel-server.js';

async function connect(mode: 'eligible' | 'inactive') {
  const channel = new ChannelServer(() => {}, false, mode);
  const client = new Client({ name: 'channel-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await (channel as unknown as { mcp: { connect: (transport: InMemoryTransport) => Promise<void> } })
    .mcp.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, channel };
}

test('inactive process tells ordinary agents not to use Lark reply', async () => {
  const { client } = await connect('inactive');
  const instructions = client.getInstructions() ?? '';
  assert.match(instructions, /inactive Lark\/Feishu channel/i);
  assert.match(instructions, /Do not call.*reply/i);
  assert.doesNotMatch(instructions, /You are connected to a Lark\/Feishu bot channel/);
  const tools = await client.listTools();
  assert.match(tools.tools.find((tool) => tool.name === 'reply')?.description ?? '', /Unavailable/i);
  await assert.rejects(
    client.callTool({ name: 'reply', arguments: { chat_id: 'oc_test', text: 'hello' } }),
    /inactive CodeBuddy session/i,
  );
  await client.close();
});

test('eligible process explains that a standby follower must wait for a channel message', async () => {
  const { client } = await connect('eligible');
  const instructions = client.getInstructions() ?? '';
  assert.match(instructions, /standby follower/i);
  assert.match(instructions, /same session/i);
  assert.match(instructions, /ordinary user messages/i);
  const reply = (await client.listTools()).tools.find((tool) => tool.name === 'reply');
  assert.match(reply?.description ?? '', /incoming.*channel/i);
  assert.deepEqual(reply?.inputSchema.required, ['chat_id', 'text']);
  assert.equal((reply?.inputSchema.properties?.chat_id as { minLength?: number })?.minLength, 1);
  await client.close();
});
