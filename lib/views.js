import { shoppingLines } from './cupboard.js';

export const plain = text => ({ type: 'plain_text', text: String(text).slice(0, 3000), emoji: true });
export const escapeMrkdwn = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const mrkdwn = text => ({ type: 'mrkdwn', text: String(text).slice(0, 3000) });
export const section = text => ({ type: 'section', text: plain(text) });
const rich = (text, accessory) => ({ type: 'section', text: mrkdwn(text), ...(accessory ? { accessory } : {}) });
const divider = () => ({ type: 'divider' });
export const button = (label, action, value = action, extra = {}) => ({ type: 'button', text: plain(label), action_id: `cupboard_${action}`, value, ...extra });
const actions = (...elements) => ({ type: 'actions', elements });
const heading = text => ({ type: 'header', text: plain(text) });
const hint = text => ({ type: 'context', elements: [plain(text)] });
const richHint = text => ({ type: 'context', elements: [mrkdwn(text)] });
const aud = amount => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(amount);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const imageAccessory = item => item?.image ? { type: 'image', image_url: item.image, alt_text: String(item.name || 'Product').slice(0, 200) } : undefined;
export const unitsHint = 'Quantities are purchase units: one multipack, one ream, or one single item as sold. Record whole packs, not individual pens inside a pack.';

// Safely convert external Markdown to Slack mrkdwn without allowing mentions or spoofed links.
export function formatOllieText(raw) {
  return escapeMrkdwn(String(raw ?? ''))
    .replace(/\r\n/g, '\n')
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function chunkText(text, max = 2800) {
  const chunks = [];
  let rest = text.slice(0, 10000);
  while (rest.length > max) {
    const cut = rest.lastIndexOf('\n', max);
    const at = cut > max * 0.5 ? cut : max;
    chunks.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function locationBadge(location) {
  if (!location) return null;
  const where = [location.state, location.postcode].filter(Boolean).join(' ');
  if (location.source === 'slack') return `📍 *${escapeMrkdwn(location.label)}* · ${where}  _(from your Slack office)_`;
  const note = location.reason && location.reason !== 'Office mapping is not configured.' ? `  _(${escapeMrkdwn(location.reason)})_` : '';
  return `📍 Shopping for *${where}*${note}`;
}

export function modal(title, mode, blocks, metadata = {}, submit) {
  return { type: 'modal', callback_id: 'cupboard', title: plain(title), close: plain('Close'), private_metadata: JSON.stringify({ mode, ...metadata }), blocks, ...(submit ? { submit: plain(submit) } : {}) };
}

function distributionText(line) {
  const parts = [];
  if (line.requesters?.length) {
    parts.push(`For: ${line.requesters.map(r => `<@${r.userId}> (${r.quantity})`).join(', ')}`);
  }
  const buffer = line.quantity - (line.requested ?? 0);
  if (buffer > 0) parts.push(`+${buffer} for cupboard stock`);
  return parts.join(' · ') || `${line.requested} requested · ${line.shortage} to reach target`;
}

export function home(state, userId, owner, ownerIds = [], cartLink = null) {
  const open = state.requests.filter(r => r.status === 'open');
  const lockedRequestIds = new Set(state.order?.lines.flatMap(line => line.requestIds ?? []) ?? []);
  const pending = open.filter(r => !lockedRequestIds.has(r.id));
  const items = Object.values(state.items);
  const stocked = items.filter(item => item.onHand !== null);
  const restockStatus = state.order ? '🟠 Order approved' : '🟢 No active order';
  const ownersText = ownerIds.length ? ownerIds.map(id => `<@${id}>`).join(', ') : null;
  const ownerLabel = ownerIds.length === 1 ? 'Cupboard owner' : 'Cupboard owners';
  const blocks = [
    heading('✏️ Cool Pens'),
    rich(ownersText
      ? `Your shared office stationery cupboard — run by ${ownersText}. Find Officeworks supplies, put them on the list, and let the owner approve the order.`
      : 'Your shared office stationery cupboard — find Officeworks supplies, put them on the list, and track the stock count.'),
    actions(
      button('✨ Find supplies', 'ask', 'ask', { style: 'primary' }),
      button(state.order ? '📦 View active order' : '🛒 Review & order', 'list'),
      button('🔄 Refresh', 'refresh'),
    ),
    richHint(`📝 *${plural(pending.length, 'item')} on the list*   ·   📦 *${plural(stocked.length, 'stocked item')}*   ·   ${restockStatus}`),
    divider(),
  ];

  if (state.order) {
    blocks.push(
      heading('🟠 Active order — ready to place & distribute'),
      rich(cartLink ? 'Order approved. Open the prepared cart to review and pay on Officeworks, then use the distribution list when the box arrives.' : 'Order approved. Review the order and product links, then use the distribution list when the box arrives.'),
    );
    for (const line of state.order.lines.slice(0, 8)) {
      const price = line.price != null ? ` · est. *${aud(line.price * line.quantity)}*` : '';
      blocks.push(rich(`*${line.quantity} × ${escapeMrkdwn(line.name)}*${price}\n${distributionText(line)}`, imageAccessory(line)));
    }
    if (owner) {
      blocks.push(actions(
        ...(cartLink ? [button('🛒 Open Officeworks cart', 'link_cart', 'cart', { url: cartLink, style: 'primary' })] : []),
        button('✅ Record delivery', 'receive', state.order.id),
        button('Cancel order', 'cancel_order', state.order.id, { style: 'danger' }),
      ));
    }
    blocks.push(divider());
  }

  const mine = pending.filter(r => owner || r.userId === userId);
  if (mine.length) {
    blocks.push(heading(owner ? '📝 On the list' : '📝 Your items on the list'));
    for (const request of mine.slice(-8).reverse()) {
      const item = state.items[request.itemId];
      const price = item.price != null ? ` · *${aud(item.price * request.quantity)}*` : '';
      const who = owner ? ` · requested by <@${request.userId}>` : '';
      const label = owner && request.userId !== userId ? 'Reject' : 'Remove';
      const extra = owner && request.userId !== userId ? { style: 'danger' } : {};
      blocks.push(rich(`*${request.quantity} × ${escapeMrkdwn(item.name)}*\nOn the list${price}${who}`, imageAccessory(item)));
      blocks.push(actions(button(label, 'cancel_request', request.id, extra)));
    }
    if (mine.length > 8) blocks.push(hint(`Showing the latest 8 of ${mine.length} requests. Open Review & order to see all.`));
  } else if (!state.order && !stocked.length) {
    blocks.push(rich('*Nothing on the list yet.*\nClick *✨ Find supplies* to pick Officeworks products and put them on the list for the cupboard owner.'));
  }

  if (stocked.length || (owner && items.length)) {
    blocks.push(
      divider(),
      heading('📦 Stock count'),
      actions(
        ...(stocked.length ? [button('📤 Take from cupboard', 'take')] : []),
        ...(owner ? [button('🔢 Count stock', 'count'), button('🗑️ Remove item', 'remove')] : []),
      ),
    );
    if (stocked.length) {
      for (const item of stocked.slice(0, 12)) {
        const status = item.onHand < item.target
          ? `🟡 *${item.onHand}* on hand · target ${item.target} · _running low_`
          : `🟢 *${item.onHand}* on hand · target ${item.target}`;
        const price = item.price != null ? ` · ${aud(item.price)}` : '';
        blocks.push(rich(`*${escapeMrkdwn(item.name)}*\n${status}${price}`, imageAccessory(item)));
      }
      if (stocked.length > 12) blocks.push(hint(`Showing 12 of ${stocked.length} stocked items.`));
    } else {
      blocks.push(hint('Items move into the stock count once counted or delivered.'));
    }
  }

  const ownerNote = ownersText
    ? `🔑 ${ownerLabel}: ${ownersText} · ${owner ? 'You hold the keys — reject cheeky requests, approve the order, buy on Officeworks, and distribute when it arrives.' : 'Holds the keys — reviews requests, approves the order, and distributes supplies when they arrive.'}`
    : (owner ? '🔑 You hold the keys — reject cheeky requests, approve the order, buy on Officeworks, and distribute when it arrives.' : '🔑 The cupboard owner reviews requests, approves the order, and distributes supplies.');
  blocks.push(
    divider(),
    hint(unitsHint),
    richHint(ownerNote),
  );
  return { type: 'home', blocks };
}

const input = (id, label, element, optional = false) => ({ type: 'input', block_id: id, label: plain(label), optional, element: { ...element, action_id: 'value' } });
const number = initial => ({ type: 'number_input', is_decimal_allowed: false, min_value: '0', max_value: '9999', ...(initial !== undefined ? { initial_value: String(initial) } : {}) });

export function form(mode, state) {
  if (mode === 'ask') {
    return modal('Find supplies', mode, [
      rich('Describe what you need and get live Officeworks product suggestions, prices, and links.'),
      input('question', 'What are you looking for?', { type: 'plain_text_input', multiline: true, max_length: 3000, placeholder: plain('Great gel pens for a team of 10, under $30') }),
    ], {}, 'Search');
  }
  if (mode === 'request') {
    return modal('Request supplies', mode, [
      hint(unitsHint),
      input('name', 'Item and pack size', { type: 'plain_text_input', max_length: 180, placeholder: plain('Black gel pens, 10 pack') }),
      input('quantity', 'Purchase units to request', { ...number(1), min_value: '1' }),
    ], {}, 'Request');
  }
  const items = Object.values(state.items);
  if (!items.length) return modal('Cupboard', 'info', [section('Find a product first so there is something on the shelf.')]);
  const fields = [hint(unitsHint), input('item', 'Item', { type: 'static_select', options: items.map(item => ({ text: plain(item.name.slice(0, 75)), value: item.id })) })];
  if (mode === 'remove') return modal('Remove item', mode, [rich('Remove an item from the cupboard shelf and cancel any open requests for it.'), fields[1]], {}, 'Remove');
  if (mode === 'take') fields.push(input('quantity', 'Purchase units taken', { ...number(1), min_value: '1' }));
  else fields.push(input('onHand', 'Purchase units currently on the shelf', number()), input('target', 'Target stock level', number()));
  return modal(mode === 'take' ? 'Take supplies' : 'Count stock', mode, fields, {}, 'Save');
}

export function shopping(state, owner, cartLink = null) {
  const order = state.order;
  const lines = order?.lines ?? shoppingLines(state);
  const blocks = [
    rich(order
      ? '🟠 *Order approved — ready to place on Officeworks.*\nReview and pay on Officeworks, then hand out each item using the distribution list when it arrives.'
      : 'Review everything on the list and any stock shortages. Click *Approve order* to lock the batch and generate the distribution list.'),
    hint(unitsHint),
    divider(),
  ];
  if (order && owner) {
    if (cartLink) blocks.splice(1, 0,
      actions(button('🛒 Open Officeworks cart', 'link_cart', 'cart', { url: cartLink, style: 'primary' })),
      hint('Adds approved quantities to your current Officeworks cart. Existing items remain. Review the cart after login, then pay on Officeworks.'),
      actions(button('Cart help / retry', 'link_cart_help', 'cart-help', { url: cartLink.replace('/order/', '/cart-help/') })),
    );
    else blocks.splice(1, 0, section('Some items have no Officeworks product code. To prepare a cart, cancel this batch and replace those requests with products from Find supplies.'));
  }

  let estimatedTotal = 0;
  let pricedLines = 0;
  for (const line of lines) {
    let priceNote = '';
    if (line.price != null) {
      const subtotal = line.price * line.quantity;
      estimatedTotal += subtotal;
      pricedLines++;
      priceNote = ` · est. *${aud(subtotal)}*`;
    }
    blocks.push(rich(
      `*${line.quantity} × ${escapeMrkdwn(line.name)}*${priceNote}\n${distributionText(line)}`,
      { type: 'button', text: plain('Officeworks ↗'), url: line.url, action_id: `cupboard_link_${blocks.length}` },
    ));
  }

  if (!lines.length) blocks.push(rich('_Nothing on the list._ Find supplies or set target stock levels.'));
  if (pricedLines) blocks.push(divider(), richHint(`💰 Estimated order total: *${aud(estimatedTotal)}*${pricedLines < lines.length ? ` _(${pricedLines} of ${lines.length} items priced)_` : ''} · based on latest Officeworks prices`));
  if (order && owner) blocks.push(actions(button('✅ Record full delivery', 'receive', order.id, { style: 'primary' }), button('Cancel order', 'cancel_order', order.id, { style: 'danger' })));
  if (lines.length) blocks.push(actions(button('✨ Source this list', 'plan')));
  return modal(order ? 'Active order' : 'Review & order', order ? 'info' : 'approve', blocks, { revision: state.revision }, !order && owner && lines.length ? 'Approve order' : undefined);
}

export function ollieBlocks(result, suggestions = [], location = null) {
  const blocks = [];
  const badge = locationBadge(location);
  if (badge) blocks.push(richHint(badge));
  blocks.push(heading('✨ Suggested supplies'));

  const formatted = formatOllieText(result.text);
  for (const chunk of chunkText(formatted)) blocks.push(rich(chunk));

  const products = result.products.slice(0, 10);
  if (products.length) {
    blocks.push(divider());
    for (const [index, product] of products.entries()) {
      const priceText = product.currency && product.price !== null
        ? `*${aud(product.price)}*${product.originalPrice ? `  ~${aud(product.originalPrice)}~` : ''}`
        : '_Check price on Officeworks_';
      const meta = [
        priceText,
        product.rating ? `★ ${product.rating}${product.reviewCount ? ` (${product.reviewCount})` : ''}` : null,
        product.brand ? escapeMrkdwn(product.brand) : null,
        product.availability === 'IN_STOCK' ? '✅ In stock' : null,
      ].filter(Boolean).join('   ·   ');

      blocks.push(rich(`*${escapeMrkdwn(product.name)}*\n${meta}`, imageAccessory(product)));
      blocks.push(actions(
        ...(suggestions[index] ? [button('➕ Request 1 pack', 'suggestion', suggestions[index], { style: 'primary' })] : []),
        { type: 'button', text: plain('View on Officeworks ↗'), url: product.url, action_id: `cupboard_link_${index}` },
      ));
      blocks.push(divider());
    }
  } else {
    blocks.push(divider());
  }

  blocks.push(actions(button('💬 Refine search', 'ask'), button('🔄 New search', 'new_chat')));
  blocks.push(hint('Live Officeworks product results · Prices & availability can change · Requesting adds to your cupboard list (doesn’t buy).'));
  if (result.actionRequested) blocks.push(hint('Request the products, approve the batch, then use Open Officeworks cart to check out.'));
  return blocks;
}
