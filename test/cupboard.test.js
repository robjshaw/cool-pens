import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryStorage, fileStorage } from 'remack';
import { createCupboard, shoppingLines } from '../lib/cupboard.js';

const owner = { teamId: 'T1', userId: 'U1' }, staff = { teamId: 'T1', userId: 'U2' };
const setup = (storage = memoryStorage()) => createCupboard({ storage, teamId: 'T1', ownerIds: ['U1'] });
async function seed(c) { await c.request(staff, { name: 'Pens 10 pack', quantity: 2 }, 'r1'); return Object.values((await c.read(owner)).items)[0].id; }

test('restock uses the greater of demand and shortage, with no double counting', async () => {
  const c = setup(), id = await seed(c);
  await c.count(owner, id, 1, 4, 'count');
  const state = await c.read(owner);
  const line = shoppingLines(state)[0];
  assert.equal(line.quantity, 3);
  assert.deepEqual(line.requesters, [{ userId: 'U2', quantity: 2 }]);
  await c.approve(owner, state.revision, 'approve');
  const order = (await c.read(owner)).order;
  await c.request(staff, { name: 'Pens 10 pack', quantity: 1 }, 'new-request');
  await c.finish(owner, order.id, true, 'receive');
  await c.finish(owner, order.id, true, 'receive');
  const after = await c.read(owner);
  assert.equal(after.items[id].onHand, 4);
  assert.equal(after.requests.length, 1);
  assert.equal(after.requests[0].quantity, 1);
});
test('concurrent requests and duplicate submissions do not lose or duplicate writes', async () => {
  const c = setup();
  await Promise.all(Array.from({ length: 30 }, (_, i) => c.request(staff, { name: 'Pens', quantity: 1 }, `r${i}`)));
  await c.request(staff, { name: 'Pens', quantity: 1 }, 'r0');
  assert.equal((await c.read(owner)).requests.length, 30);
  assert.equal(shoppingLines(await c.read(owner))[0].quantity, 30);
});
test('owner permission and workspace restrictions are enforced in the service', async () => {
  const c = setup(), id = await seed(c);
  assert.throws(() => c.count(staff, id, 1, 2, 'bad'), /owner/);
  assert.throws(() => c.approve(staff, 1, 'bad'), /owner/);
  await assert.rejects(c.read({ ...staff, teamId: 'T_OTHER' }), /different/);
  const request = (await c.read(owner)).requests[0];
  await assert.rejects(c.cancelRequest({ ...staff, userId: 'U_OTHER' }, request.id, 'bad'), /own requests/);
});
test('stale approvals and repeated receipts cannot mutate stock', async () => {
  const c = setup(), id = await seed(c), old = await c.read(owner);
  await c.count(owner, id, 0, 0, 'count');
  await assert.rejects(c.approve(owner, old.revision, 'old'), /changed/);
  await c.approve(owner, (await c.read(owner)).revision, 'approve');
  await assert.rejects(c.approve(owner, 0, 'another'), /already approved/);
  const order = (await c.read(owner)).order;
  await c.finish(owner, order.id, true, 'receive');
  await assert.rejects(c.finish(owner, order.id, true, 'second-click'), /already/);
  assert.equal((await c.read(owner)).items[id].onHand, 2);
});
test('unknown stock, invalid quantities, and overdraws are rejected', async () => {
  const c = setup(), id = await seed(c);
  await assert.rejects(c.take(staff, id, 1, 'take'), /count/);
  for (const quantity of [0, -1, 1.5, Infinity, NaN]) assert.throws(() => c.request(staff, { name: 'Pens', quantity }, 'invalid'), /whole/);
  await c.approve(owner, (await c.read(owner)).revision, 'approve');
  await assert.rejects(c.finish(owner, (await c.read(owner)).order.id, true, 'receive'), /Count/);
  await c.count(owner, id, 1, 0, 'count');
  await assert.rejects(c.take(staff, id, 2, 'take'), /not enough/);
  await c.take(staff, id, 1, 'take');
  assert.equal((await c.read(owner)).items[id].onHand, 0);
});
test('cancelling an approved batch releases requests without changing stock', async () => {
  const c = setup(); await seed(c);
  await c.approve(owner, (await c.read(owner)).revision, 'approve');
  const state = await c.read(owner);
  await assert.rejects(c.cancelRequest(staff, state.requests[0].id, 'cancel-r'), /approved restock/);
  await c.finish(owner, state.order.id, false, 'cancel');
  assert.equal(shoppingLines(await c.read(owner))[0].quantity, 2);
  await c.cancelRequest(staff, state.requests[0].id, 'cancel-r');
  assert.equal(shoppingLines(await c.read(owner)).length, 0);
  assert.equal(Object.keys((await c.read(owner)).items).length, 0);
});
test('owner can remove a tracked item unless it is in an approved restock', async () => {
  const c = setup(), id = await seed(c);
  await c.count(owner, id, 2, 4, 'count');
  assert.throws(() => c.removeItem(staff, id, 'staff-rm'), /owner/);
  await c.approve(owner, (await c.read(owner)).revision, 'approve');
  await assert.rejects(c.removeItem(owner, id, 'rm-locked'), /approved restock/);
  await c.finish(owner, (await c.read(owner)).order.id, false, 'cancel');
  await c.removeItem(owner, id, 'rm-ok');
  const after = await c.read(owner);
  assert.equal(Object.keys(after.items).length, 0);
  assert.equal(after.requests.filter(r => r.status === 'open').length, 0);
});
test('file storage survives restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cool-pens-test-'));
  try {
    const file = join(dir, 'state.json'), c = setup(fileStorage(file));
    await seed(c);
    assert.equal((await setup(fileStorage(file)).read(owner)).requests.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
