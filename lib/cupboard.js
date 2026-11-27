import { randomUUID, createHash } from 'node:crypto';

export class CupboardError extends Error {}
const fail = message => { throw new CupboardError(message); };
const integer = (value, min = 1) => Number.isInteger(Number(value)) && Number(value) >= min && Number(value) <= 9999 ? Number(value) : fail(`Enter a whole number from ${min} to 9,999.`);
const clean = value => typeof value === 'string' && value.trim() && value.length <= 180 ? value.trim() : fail('Use an item name between 1 and 180 characters.');
const empty = () => ({ revision: 0, items: {}, requests: [], order: null, history: [], seen: [] });

export function shoppingLines(state) {
  return Object.values(state.items).flatMap(item => {
    const requests = state.requests.filter(r => r.itemId === item.id && r.status === 'open');
    const requested = requests.reduce((n, r) => n + r.quantity, 0);
    const shortage = item.onHand === null ? 0 : Math.max(0, item.target - item.onHand);
    const quantity = Math.max(requested, shortage);
    if (!quantity) return [];
    const byUser = new Map();
    for (const r of requests) byUser.set(r.userId, (byUser.get(r.userId) ?? 0) + r.quantity);
    const requesters = [...byUser.entries()].map(([userId, qty]) => ({ userId, quantity: qty }));
    return [{ ...item, quantity, requested, shortage, requestIds: requests.map(r => r.id), requesters }];
  });
}

export function createCupboard({ storage, teamId, ownerIds }) {
  const owners = new Set(ownerIds);
  if (!teamId || !owners.size) throw new Error('Configure SLACK_TEAM_ID and CUPBOARD_OWNER_IDS.');
  let queue = Promise.resolve();
  const authorize = (actor, owner = false) => {
    if (actor.teamId !== teamId || !actor.userId) fail('This cupboard belongs to a different Slack workspace.');
    if (owner && !owners.has(actor.userId)) fail('Only a cupboard owner can do that.');
  };
  const load = async () => structuredClone(await storage.get('cupboard', teamId) ?? empty());
  function change(actor, owner, key, update) {
    authorize(actor, owner);
    const work = queue.then(async () => {
      const state = await load();
      if (key && state.seen.includes(key)) return state;
      await update(state);
      state.revision++;
      if (key) state.seen = [...state.seen.slice(-999), key];
      await storage.put('cupboard', teamId, state);
      return state;
    });
    queue = work.catch(() => {});
    return work;
  }
  return {
    authorize,
    ownerIds: [...owners],
    isOwner: userId => owners.has(userId),
    async read(actor) { authorize(actor); await queue; return load(); },
    request(actor, { name, quantity, product }, key) {
      name = clean(name); quantity = integer(quantity);
      return change(actor, false, key, state => {
        if (state.requests.filter(r => r.status === 'open').length >= 200) fail('The request list is full. Ask an owner to finish a restock first.');
        const id = product?.id ? `sku:${product.id}` : `item:${createHash('sha256').update(name.toLowerCase()).digest('hex').slice(0, 16)}`;
        if (!state.items[id] && Object.keys(state.items).length >= 80) fail('The MVP supports up to 80 cupboard items.');
        state.items[id] ??= { id, name, url: product?.url ?? `https://www.officeworks.com.au/shop/officeworks/search?q=${encodeURIComponent(name)}`, onHand: null, target: 0, image: product?.image ?? null, price: product?.price ?? null, brand: product?.brand ?? null };
        if (product?.image && !state.items[id].image) state.items[id].image = product.image;
        if (product?.price != null) state.items[id].price = product.price;
        if (product?.brand && !state.items[id].brand) state.items[id].brand = product.brand;
        state.requests.push({ id: randomUUID(), itemId: id, quantity, userId: actor.userId, status: 'open', createdAt: new Date().toISOString() });
      });
    },
    take(actor, id, quantity, key) {
      quantity = integer(quantity);
      return change(actor, false, key, state => {
        const item = state.items[id];
        if (!item || item.onHand === null) fail('An owner needs to count this item first.');
        if (item.onHand < quantity) fail('There is not enough recorded stock. Request a restock instead.');
        item.onHand -= quantity;
      });
    },
    count(actor, id, onHand, target, key) {
      onHand = integer(onHand, 0); target = integer(target, 0);
      return change(actor, true, key, state => {
        if (!state.items[id]) fail('That item no longer exists.');
        Object.assign(state.items[id], { onHand, target });
      });
    },
    cancelRequest(actor, id, key) {
      return change(actor, false, key, state => {
        const request = state.requests.find(r => r.id === id);
        if (!request || request.status !== 'open') fail('That request is no longer open.');
        if (request.userId !== actor.userId && !owners.has(actor.userId)) fail('You can only cancel your own requests.');
        if (state.order?.lines.some(line => line.requestIds.includes(id))) fail('This request is in an approved restock. Ask the owner to cancel that batch first.');
        request.status = 'cancelled';
        const item = state.items[request.itemId];
        const hasOpen = state.requests.some(r => r.itemId === request.itemId && r.status === 'open');
        const inOrder = state.order?.lines.some(line => line.id === request.itemId);
        if (item && item.onHand === null && item.target === 0 && !hasOpen && !inOrder) delete state.items[request.itemId];
      });
    },
    removeItem(actor, id, key) {
      return change(actor, true, key, state => {
        if (!state.items[id]) fail('That item no longer exists.');
        if (state.order?.lines.some(line => line.id === id)) fail('This item is in an approved restock. Cancel or finish that batch first.');
        delete state.items[id];
        for (const request of state.requests) if (request.itemId === id && request.status === 'open') request.status = 'cancelled';
      });
    },
    approve(actor, revision, key) {
      return change(actor, true, key, state => {
        if (state.order) fail('A restock is already approved. Receive or cancel it first.');
        if (state.revision !== Number(revision)) fail('The cupboard changed. Reopen the shopping list and review it again.');
        const lines = shoppingLines(state);
        if (!lines.length) fail('There is nothing to restock.');
        state.order = { id: randomUUID(), lines, approvedBy: actor.userId, approvedAt: new Date().toISOString() };
      });
    },
    finish(actor, id, received, key) {
      return change(actor, true, key, state => {
        if (!state.order || state.order.id !== id) fail('That restock has already been completed or cancelled.');
        if (received) {
          if (state.order.lines.some(line => state.items[line.id].onHand === null)) fail('Count the existing stock for every item in this batch before receiving it.');
          for (const line of state.order.lines) {
            state.items[line.id].onHand += line.quantity;
            for (const request of state.requests) if (line.requestIds.includes(request.id)) request.status = 'received';
          }
        }
        state.history = [...state.history.slice(-19), { ...state.order, status: received ? 'received' : 'cancelled', finishedBy: actor.userId, finishedAt: new Date().toISOString() }];
        state.order = null;
        state.requests = state.requests.filter(r => r.status === 'open');
      });
    },
  };
}
