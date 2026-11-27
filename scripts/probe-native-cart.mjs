// Explicit live probe. Uses disposable guest cookies, no real account or purchase.
import assert from 'node:assert/strict';
import { memoryStorage } from 'remack';
import { buildApp } from '../app.js';
import { nativeCartUrl } from '../lib/cart-handoff.js';
const env = { SLACK_SIGNING_SECRET: 'disposable-probe-secret', SLACK_BOT_TOKEN: 'xoxb-probe', SLACK_TEAM_ID: 'TPROBE', CUPBOARD_OWNER_IDS: 'PROBE', PUBLIC_BASE_URL: 'https://probe.invalid' };
const logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(key => [key, () => {}]));
const { cupboard, cartHandoff, fetch: appFetch, app } = buildApp({ env, storage: memoryStorage(), ollie: {}, logger });
await app.ready;
const actor = { teamId: 'TPROBE', userId: 'PROBE' };
const items = [{ sku: 'PM1956279', quantity: 2 }, { sku: 'SM4518C24B', quantity: 1 }];
for (const item of items) await cupboard.request(actor, { name: item.sku, quantity: item.quantity, product: { id: item.sku } });
const before = await cupboard.read(actor);
const state = await cupboard.approve(actor, before.revision);
const link = cartHandoff.link(state.order);
const jar = new Map();
async function guestFetch(url, init = {}) {
  const target = new URL(url);
  assert.equal(target.origin, 'https://www.officeworks.com.au');
  const response = await fetch(target, { ...init, redirect: 'manual', signal: AbortSignal.timeout(25000),
    headers: { ...init.headers, cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; ') } });
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(';')[0], split = pair.indexOf('=');
    jar.set(pair.slice(0, split), pair.slice(split + 1));
  }
  return response;
}
const readCart = async () => {
  const response = await guestFetch('https://www.officeworks.com.au/app/header/api/cart');
  if (response.status === 404) return { items: [] };
  assert.equal(response.status, 200); return response.json();
};
let appCookie = '';
try {
  for (let pass = 1; pass <= 2; pass++) {
    const response = await appFetch(new Request(link, { headers: { 'sec-fetch-mode': 'navigate', cookie: appCookie } }));
    assert.equal(response.status, 303);
    appCookie = response.headers.get('set-cookie').split(';')[0];
    let url = response.headers.get('location');
    const startsWithAdd = new URL(url).pathname.endsWith('/OrderItemAdd');
    assert.equal(startsWithAdd, pass === 1);
    for (let hop = 0; hop < 5; hop++) {
      const remote = await guestFetch(url);
      if ([301, 302, 303, 307, 308].includes(remote.status)) {
        url = new URL(remote.headers.get('location'), url).href;
        await remote.body?.cancel(); continue;
      }
      assert.equal(remote.status, 200);
      assert.match(new URL(url).pathname, /^\/app\/checkout\/?$/);
      await remote.body?.cancel(); break;
    }
    const cart = await readCart();
    const actual = cart.items.map(({ sku, quantity }) => ({ sku, quantity }));
    assert.deepEqual(actual.sort((a, b) => a.sku.localeCompare(b.sku)), [...items].sort((a, b) => a.sku.localeCompare(b.sku)));
    console.log(`Pass ${pass}: redirected to checkout; exact products and quantities verified.`, actual);
  }
  console.log('Native guest-session handoff passed, including repeat-click protection. No extension or account credentials used.');
  if (process.argv.includes('--edge-cases')) {
    const beforeFailure = (await readCart()).items.map(({ sku, quantity }) => ({ sku, quantity }));
    const invalid = nativeCartUrl({ lines: [
      { id: 'sku:PM1956279', name: 'Valid item', quantity: 1 },
      { id: 'sku:COOLPENS_INVALID_SKU_20261125', name: 'Deliberately unavailable probe item', quantity: 1 },
    ] });
    const failed = await guestFetch(invalid);
    await failed.body?.cancel();
    const afterFailure = (await readCart()).items.map(({ sku, quantity }) => ({ sku, quantity }));
    assert.deepEqual(afterFailure, beforeFailure, 'An invalid SKU must not partially add the preceding valid SKU.');
    console.log(`Invalid-SKU check: Officeworks returned ${failed.status}; existing cart unchanged, no partial import.`);
  }
} finally {
  const cart = await readCart();
  for (const item of cart.items) {
    const response = await guestFetch(`https://www.officeworks.com.au/app/header/api/cart/${encodeURIComponent(cart.cartId)}/items/${encodeURIComponent(item.itemId)}`, { method: 'DELETE' });
    assert.equal(response.ok, true);
  }
  console.log('Disposable guest cart emptied. No order placed.');
}
