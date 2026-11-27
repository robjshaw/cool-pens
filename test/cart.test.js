import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryStorage } from 'remack';
import { buildApp } from '../app.js';
import { home, shopping } from '../lib/views.js';
import { handoffOrigin, nativeCartUrl } from '../lib/cart-handoff.js';

const env = { SLACK_SIGNING_SECRET: 'secret', SLACK_BOT_TOKEN: 'xoxb-test', SLACK_TEAM_ID: 'T1', CUPBOARD_OWNER_IDS: 'OWNER', PUBLIC_BASE_URL: 'https://cupboard.example' };
const owner = { teamId: 'T1', userId: 'OWNER' };
const items = [{ sku: 'PENS', quantity: 2, name: 'Pens' }, { sku: 'PAPER', quantity: 1, name: 'Paper' }];
const logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(key => [key, () => {}]));
async function approved() {
  const result = buildApp({ env, storage: memoryStorage(), ollie: {}, logger });
  await result.app.ready;
  for (const item of items) await result.cupboard.request(owner, { name: item.name, quantity: item.quantity, product: { id: item.sku, url: `https://www.officeworks.com.au/shop/officeworks/p/${item.sku}` } });
  const before = await result.cupboard.read(owner);
  const state = await result.cupboard.approve(owner, before.revision);
  return { ...result, state, link: result.cartHandoff.link(state.order) };
}

test('approved handoff serves exact frozen quantities, with no requester or Slack secrets', async () => {
  const { cupboard, state, link, fetch } = await approved();
  assert.ok(link.startsWith(env.PUBLIC_BASE_URL + '/order/'));
  await cupboard.request(owner, { name: 'Pens', quantity: 5, product: { id: 'PENS' } });
  const response = await fetch(new Request(link.replace('/order/', '/api/order/')));
  assert.deepEqual(await response.json(), { id: state.order.id, items });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const page = await fetch(new Request(link)); assert.match(await page.text(), /2 × Pens/);
  assert.equal((await fetch(new Request(link, { method: 'POST' }))).status, 403);
  assert.equal((await fetch(new Request(link.replace('/order/', '/api/order/'), { method: 'POST' }))).status, 405);
  assert.equal((await fetch(new Request(link, { method: 'HEAD' }))).status, 200);
  const forged = link.slice(0, -1) + (link.endsWith('A') ? 'B' : 'A');
  assert.equal((await fetch(new Request(forged))).status, 404);
  await cupboard.finish(owner, state.order.id, false);
  assert.equal((await fetch(new Request(link))).status, 410);
  assert.equal((await fetch(new Request(link.replace('/order/', '/api/order/')))).status, 410);
});
test('native handoff redirects a browser to bulk add; repeated clicks open checkout without adding', async () => {
  const { link, fetch, state } = await approved();
  const response = await fetch(new Request(link, { headers: { 'sec-fetch-mode': 'navigate' } }));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), nativeCartUrl(state.order));
  const destination = new URL(response.headers.get('location'));
  assert.equal(destination.origin, 'https://www.officeworks.com.au');
  assert.equal(destination.pathname, '/webapp/wcs/stores/servlet/OrderItemAdd');
  assert.equal(destination.searchParams.get('partNumber_1'), 'PENS');
  assert.equal(destination.searchParams.get('quantity_1'), '2');
  assert.equal(destination.searchParams.get('partNumber_2'), 'PAPER');
  assert.equal(destination.searchParams.get('URL'), '/app/checkout');
  assert.equal(destination.searchParams.get('continue'), '0');
  assert.doesNotMatch(destination.href, /OWNER|secret|xoxb/);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  const repeated = await fetch(new Request(link, { headers: { cookie, 'sec-fetch-mode': 'navigate' } }));
  assert.equal(repeated.headers.get('location'), 'https://www.officeworks.com.au/app/checkout');
  const help = await fetch(new Request(link.replace('/order/', '/cart-help/'), { headers: { cookie } }));
  assert.match(await help.text(), /Adding again can duplicate/);
  const retry = await fetch(new Request(link, { method: 'POST', headers: { cookie, origin: env.PUBLIC_BASE_URL } }));
  assert.equal(retry.headers.get('location'), nativeCartUrl(state.order));
  const forgedRetry = await fetch(new Request(link, { method: 'POST', headers: { origin: 'https://elsewhere.example' } }));
  assert.equal(forgedRetry.status, 403);
});
test('unfurls, prefetches and HEAD checks never start a cart handoff', async () => {
  const { link, fetch } = await approved();
  for (const init of [{}, { method: 'HEAD' }, { headers: { 'sec-fetch-mode': 'navigate', 'sec-purpose': 'prefetch' } }]) {
    const response = await fetch(new Request(link, init));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('location'), null);
    assert.equal(response.headers.get('set-cookie'), null);
  }
});
test('only owners see the handoff link and manual requests do not produce incomplete carts', async () => {
  const { state, link, cupboard, cartHandoff } = await approved();
  assert.match(JSON.stringify(shopping(state, true, link)), /Open Officeworks cart/);
  assert.doesNotMatch(JSON.stringify(shopping(state, false, link)), /\/order\//);
  assert.doesNotMatch(JSON.stringify(home(state, 'STAFF', false, ['OWNER'], link)), /\/order\//);
  await cupboard.finish(owner, state.order.id, false);
  await cupboard.request(owner, { name: 'Find me scissors', quantity: 1 });
  const before = await cupboard.read(owner);
  const manual = await cupboard.approve(owner, before.revision);
  assert.equal(cartHandoff.link(manual.order), null);
});
test('origin configuration restricts links to HTTPS or local development', () => {
  assert.equal(handoffOrigin({ PORT: '4000' }), 'http://localhost:4000');
  for (const PUBLIC_BASE_URL of ['http://public.example', 'https://u:p@example.com', 'https://example.com/path', 'https://example.com?q=1']) assert.throws(() => handoffOrigin({ PUBLIC_BASE_URL }));
});
