import { createHmac, timingSafeEqual } from 'node:crypto';

export function handoffOrigin(env) {
  const url = new URL(env.PUBLIC_BASE_URL || `http://localhost:${env.PORT || 3000}`);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
    throw new Error('PUBLIC_BASE_URL must be an HTTPS origin, or localhost for development.');
  }
  return url.origin;
}

export function orderItems(order) {
  if (!order?.lines?.length) throw new Error('There is no approved order.');
  return order.lines.map(line => {
    const sku = line.id?.startsWith('sku:') ? line.id.slice(4) : '';
    if (!/^[A-Z0-9_-]{1,60}$/i.test(sku) || !Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 9999) {
      throw new Error('Every item needs an Officeworks product code. Cancel this batch and choose products from Find supplies before approving again.');
    }
    return { sku, quantity: line.quantity, name: line.name };
  });
}

export function nativeCartUrl(order) {
  const url = new URL('https://www.officeworks.com.au/webapp/wcs/stores/servlet/OrderItemAdd');
  url.search = new URLSearchParams({ storeId: '10151', catalogId: '10551', langId: '-1', orderId: '.', URL: '/app/checkout', continue: '0' });
  orderItems(order).forEach((item, index) => {
    url.searchParams.set(`partNumber_${index + 1}`, item.sku);
    url.searchParams.set(`quantity_${index + 1}`, String(item.quantity));
  });
  return url.href;
}

const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://www.officeworks.com.au" };

export function createCartHandoff({ env, cupboard }) {
  const origin = handoffOrigin(env);
  // Separate signing domain: a link grants this batch's handoff, never Slack access.
  const sign = id => createHmac('sha256', env.SLACK_SIGNING_SECRET).update(`cool-pens-cart-v1:${env.SLACK_TEAM_ID}:${id}`).digest('base64url');
  const tokenFor = order => `${order.id}.${sign(order.id)}`;
  const link = order => {
    try { orderItems(order); return `${origin}/order/${tokenFor(order)}`; } catch { return null; }
  };
  async function fetch(request) {
    const path = new URL(request.url).pathname;
    const match = path.match(/^\/(order|cart-help|api\/order)\/([^/]+)$/);
    if (!match) return null;
    const [, route, token] = match;
    const methods = route === 'order' ? ['GET', 'HEAD', 'POST'] : ['GET', 'HEAD'];
    if (!methods.includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { ...headers, allow: methods.join(', ') } });
    if (request.method === 'POST' && request.headers.get('origin') !== origin) return new Response('Reopen Cart help from Slack to retry.', { status: 403, headers });
    const parts = token.match(/^([0-9a-f-]{36})\.([\w-]{43})$/i);
    if (!parts || !timingSafeEqual(Buffer.from(parts[2]), Buffer.from(sign(parts[1])))) return new Response('This order link is invalid.', { status: 404, headers });
    const state = await cupboard.read({ teamId: env.SLACK_TEAM_ID, userId: cupboard.ownerIds[0] });
    if (state.order?.id !== parts[1]) return new Response('This batch has been cancelled or completed. Open the current order in Slack.', { status: 410, headers });
    let items;
    try { items = orderItems(state.order); } catch (error) { return new Response(error.message, { status: 409, headers }); }
    if (route === 'api/order') return new Response(request.method === 'HEAD' ? null : JSON.stringify({ id: state.order.id, items }), { headers: { ...headers, 'content-type': 'application/json' } });
    if (request.method === 'HEAD') return new Response(null, { headers });
    const cookieName = 'cool_pens_handoff';
    const alreadyOpened = (request.headers.get('cookie') || '').split(';').some(part => part.trim() === `${cookieName}=${token}`);
    // Only real top-level navigations auto-open. Slack unfurls/prefetches get the help page.
    const navigating = request.headers.get('sec-fetch-mode') === 'navigate' &&
      !/prefetch|prerender/i.test(`${request.headers.get('purpose') || ''} ${request.headers.get('sec-purpose') || ''}`);
    if (route === 'order' && (navigating || request.method === 'POST')) {
      const retry = request.method === 'POST';
      return new Response(null, { status: 303, headers: { ...headers,
        location: alreadyOpened && !retry ? 'https://www.officeworks.com.au/app/checkout' : nativeCartUrl(state.order),
        'set-cookie': `${cookieName}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${origin.startsWith('https:') ? '; Secure' : ''}`,
      } });
    }
    const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Approved order · Cool Pens</title>
      <style>body{font:17px/1.6 system-ui;color:#182d32;background:#f5f4ed;margin:0}main{max-width:640px;margin:8vh auto;padding:32px;background:white;border-radius:20px}h1{font-size:36px;line-height:1.15}li{padding:8px 0}aside{background:#edf6ef;padding:20px;border-radius:12px}button{font:inherit;background:#173f38;color:white;border:0;padding:12px 20px;border-radius:8px;cursor:pointer}a{color:#173f38}small{color:#516268}</style>
      <main><small>COOL PENS / APPROVED ORDER</small><h1>Your stationery is ready to go.</h1>
      <p>Open your Officeworks cart to review prices, delivery and payment. Use your usual Officeworks login when asked.</p>
      <ul>${items.map(item => `<li><strong>${item.quantity} × ${escape(item.name)}</strong><br><small>${escape(item.sku)}</small></li>`).join('')}</ul>
      <aside>${alreadyOpened ? '<strong>This batch has already been opened from this browser.</strong><p>That records the handoff attempt, not a confirmed purchase. Check your cart before adding anything again.</p>' : '<strong>Add the approved list to Officeworks</strong><p>These quantities will be added to your current cart. Existing items stay there, including any quantities of the same products.</p>'}
      <p><a href="https://www.officeworks.com.au/app/checkout">Review my existing Officeworks cart</a></p>
      <form method="post" action="/order/${escape(token)}"><button>${alreadyOpened ? 'Add approved quantities again' : 'Add approved list and open cart'}</button></form>
      ${alreadyOpened ? '<p>Adding again can duplicate quantities. Use this only after checking and correcting the cart, or if the first attempt failed.</p>' : ''}</aside>
      <p>This does not place or pay for an order. After logging in, check the list again: Officeworks may restore your account’s previous cart. If needed, return here to add the approved list while logged in.</p><small>Keep this link within your purchasing team.</small></main></html>`;
    return new Response(request.method === 'HEAD' ? null : html, { headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } });
  }
  return { link, fetch };
}
