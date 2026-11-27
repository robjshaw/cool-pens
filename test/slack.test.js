import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { memoryStorage } from 'remack';
import { buildApp } from '../app.js';
import { formatOllieText, ollieBlocks } from '../lib/views.js';

const env = { SLACK_SIGNING_SECRET: 'test-secret', SLACK_BOT_TOKEN: 'xoxb-test', SLACK_TEAM_ID: 'T1', CUPBOARD_OWNER_IDS: 'OWNER' };
const logger = Object.fromEntries(['info','warn','error','debug'].map(key => [key, () => {}]));
function signed(body, secret = env.SLACK_SIGNING_SECRET) {
  const raw = body.toString(), timestamp = Math.floor(Date.now() / 1000);
  return new Request('https://bot.test/events', { method: 'POST', body: raw, headers: {
    'content-type': 'application/x-www-form-urlencoded', 'x-slack-request-timestamp': String(timestamp),
    'x-slack-signature': `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${raw}`).digest('hex')}`,
  } });
}
const commandRequest = (text, team = 'T1') => signed(new URLSearchParams({ command: '/cupboard', text, team_id: team, user_id: 'STAFF', channel_id: 'C1', trigger_id: 'trigger', response_url: 'https://hooks.slack.com/commands/test' }));
const interaction = payload => signed(new URLSearchParams({ payload: JSON.stringify(payload) }));
const submission = (mode, fields, user = 'STAFF', id = 'V1') => interaction({ type: 'view_submission', team: { id: 'T1' }, user: { id: user }, view: { id, type: 'modal', callback_id: 'cupboard', private_metadata: JSON.stringify({ mode }), blocks: Object.keys(fields).map(id => ({ type: 'input', block_id: id })), state: { values: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { value: { value } }])) } } });
async function setup(t, ollie) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body) }); return Response.json({ ok: true }); });
  const result = buildApp({ env, storage: memoryStorage(), ollie, logger }); await result.app.ready;
  return { ...result, calls };
}

test('signed command renders cupboard; invalid signatures and other teams are rejected', async t => {
  const { app } = await setup(t, {});
  const response = await app.fetch(commandRequest(''));
  assert.equal(response.status, 200); const message = await response.json(); assert.equal(message.response_type, 'ephemeral'); assert.ok(message.blocks.length);
  assert.match(JSON.stringify(message.blocks), /<@OWNER>/);
  assert.doesNotMatch(JSON.stringify(message.blocks), /\bollie\b/i);
  const forged = await app.fetch(signed(new URLSearchParams({ command: '/cupboard' }), 'wrong'));
  assert.equal(forged.status, 401);
  const other = await app.fetch(commandRequest('', 'T_OTHER'));
  assert.match((await other.json()).text, /different Slack workspace/);
});
test('ask acknowledges before waiting for Ollie and delivers product request buttons', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; }); let called = false;
  const { app, calls } = await setup(t, { ask: async (key, question) => {
    assert.equal(key, 'T1:STAFF'); assert.equal(question, 'nice pens'); called = true; await gate;
    return { text: 'Here are some pens.', products: [{ id: 'P1', name: 'Gel pens 10 pack', url: 'https://www.officeworks.com.au/shop/officeworks/p/pens-p1', price: 10, currency: 'AUD' }] };
  } });
  const response = await app.fetch(commandRequest('ask nice pens'));
  assert.match((await response.json()).text, /Searching Officeworks/);
  release(); await app.idle(); assert.equal(called, true);
  const message = calls.find(call => call.url.includes('hooks.slack.com')).body;
  assert.ok(message.blocks.some(block => block.elements?.some(element => element.action_id === 'cupboard_suggestion')));
});
test('modal requests persist once and refresh App Home', async t => {
  const { app, cupboard, calls } = await setup(t, {});
  for (let i = 0; i < 2; i++) {
    const response = await app.fetch(submission('request', { name: 'Black pens 10 pack', quantity: '2' }));
    assert.equal((await response.json()).response_action, 'update'); await app.idle();
  }
  assert.equal((await cupboard.read({ teamId: 'T1', userId: 'OWNER' })).requests.length, 1);
  assert.ok(calls.some(call => call.url.includes('views.publish')));
});
test('invalid modal input and unauthorised count stay in the modal', async t => {
  const { app } = await setup(t, {});
  const invalid = await app.fetch(submission('request', { name: 'Pens', quantity: '0' }));
  assert.equal((await invalid.json()).response_action, 'errors');
  const unauthorised = await app.fetch(submission('count', { item: 'anything', onHand: '1', target: '2' }));
  assert.match(JSON.stringify(await unauthorised.json()), /owner/);
});
test('actions within a modal push a new view', async t => {
  const { app, calls } = await setup(t, {});
  await app.fetch(interaction({ type: 'block_actions', team: { id: 'T1' }, user: { id: 'OWNER' }, trigger_id: 'trigger', view: { id: 'V_LIST', type: 'modal' }, actions: [{ action_id: 'cupboard_receive', value: 'order' }] }));
  await app.idle(); assert.ok(calls.some(call => call.url.includes('views.push')));
});
test('approval immediately returns the prepared-cart button and persists the approved quantities', async t => {
  const { app, cupboard, calls } = await setup(t, {});
  const owner = { teamId: 'T1', userId: 'OWNER' };
  await cupboard.request(owner, { name: 'Pens', quantity: 2, product: { id: 'PM1956279', url: 'https://www.officeworks.com.au/shop/officeworks/p/pens' } });
  const state = await cupboard.read(owner);
  const response = await app.fetch(interaction({ type: 'view_submission', team: { id: 'T1' }, user: { id: 'OWNER' }, view: {
    id: 'V_APPROVE', type: 'modal', callback_id: 'cupboard', private_metadata: JSON.stringify({ mode: 'approve', revision: state.revision }), blocks: [], state: { values: {} },
  } }));
  const result = await response.json();
  assert.equal(result.response_action, 'update');
  const button = result.view.blocks.flatMap(block => block.elements ?? []).find(element => element.action_id === 'cupboard_link_cart');
  assert.ok(button.url.startsWith('http://localhost:3000/order/'));
  assert.equal((await cupboard.read(owner)).order.lines[0].quantity, 2);
  await app.idle();
  assert.ok(calls.some(call => call.url.includes('views.publish') && JSON.stringify(call.body).includes('cupboard_link_cart')));
});
test('Slack office mapping reaches Ollie after ack and shows the chosen location', async t => {
  const replies = []; let supplied;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).includes('users.profile.get')) return Response.json({ ok: true, profile: { fields: { Xoffice: { value: 'Melbourne' } }, email: 'not-to-be-shared@example.test' } });
    replies.push(JSON.parse(init.body)); return Response.json({ ok: true });
  });
  const { app } = buildApp({ env: { ...env, SLACK_OFFICE_FIELD_ID: 'Xoffice', OFFICE_LOCATIONS: '{"Melbourne":{"state":"VIC","postcode":"3000"}}' }, storage: memoryStorage(), logger,
    ollie: { ask: async (key, question, location) => { supplied = location; return { text: 'Pens', products: [] }; } } });
  await app.ready;
  const response = await app.fetch(commandRequest('ask pens')); assert.match((await response.json()).text, /Searching Officeworks/);
  await app.idle(); assert.equal(supplied.postcode, '3000'); assert.equal(supplied.state, 'VIC');
  assert.doesNotMatch(JSON.stringify(supplied), /not-to-be-shared/); assert.match(JSON.stringify(replies), /Melbourne/);
});
test('Ollie markdown is safely converted to Slack mrkdwn and product cards include thumbnails', () => {
  const safe = formatOllieText('### Gel Pens\n- **Great pick** for <!channel> and <https://evil.test|free>');
  assert.equal(safe, '*Gel Pens*\n• *Great pick* for &lt;!channel&gt; and &lt;https://evil.test|free&gt;');
  const blocks = ollieBlocks({
    text: '### Top picks',
    products: [{ id: 'P1', name: 'InkJoy 10 Pack', url: 'https://www.officeworks.com.au/shop/officeworks/p/p1', price: 14.99, currency: 'AUD', originalPrice: 19.99, image: 'https://s3-ap-southeast-2.amazonaws.com/wc-prod-pim/JPEG_300x300/P1.jpg', brand: 'Paper Mate', rating: 4.8, reviewCount: 655, availability: 'IN_STOCK' }],
  }, ['sug-1'], { state: 'NSW', postcode: '2020', source: 'default', reason: 'Office mapping is not configured.' });
  const card = blocks.find(b => b.accessory?.type === 'image');
  assert.ok(card);
  assert.match(card.text.text, /\$14\.99.*~\$19\.99~.*★ 4\.8 \(655\).*Paper Mate.*In stock/);
  assert.doesNotMatch(JSON.stringify(blocks), /Office mapping is not configured/);
});
