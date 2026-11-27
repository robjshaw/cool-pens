import { randomUUID } from 'node:crypto';

export const TOKEN_URL = 'https://www.officeworks.com.au/app/header/api/cart/get-token';
export const CONFIG_URL = 'https://agenticapplications.googleapis.com/v1/sales:retrieveConfig';
export const CHAT_URL = 'https://agenticapplications.googleapis.com/v1/sales:executeChat?alt=sse';
export const MERCHANT_ID = 'llsudioqpaq1qjku';
export const CLIENT_ID = 'OFFICEWORKS';

export class OllieError extends Error {}

// SSE frames may cross network chunks, contain multiple data lines, and use CRLF.
export async function* readEvents(body) {
  if (!body) throw new OllieError('Ollie returned an empty stream.');
  const decoder = new TextDecoder();
  let buffer = '', data = [], total = 0;
  function parse() {
    const raw = data.join('\n'); data = [];
    if (!raw || raw === '[DONE]') return null;
    try { return JSON.parse(raw); } catch { throw new OllieError('Ollie returned an unreadable response. Please try again.'); }
  }
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > 2_000_000) throw new OllieError('Ollie’s response was too large. Try a narrower question.');
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
      if (!line) { const event = parse(); if (event) yield event; }
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
  }
  buffer += decoder.decode();
  if (buffer.startsWith('data:')) data.push(buffer.slice(5).trim());
  const event = parse(); if (event) yield event;
}

const IMAGE_HOSTS = new Set(['s3-ap-southeast-2.amazonaws.com', 'www.officeworks.com.au', 'officeworks.com.au']);
function safeImage(raw) {
  for (const candidate of Array.isArray(raw?.imageUris) ? raw.imageUris : []) {
    if (typeof candidate !== 'string') continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === 'https:' && (IMAGE_HOSTS.has(url.hostname) || url.hostname.endsWith('.officeworks.com.au'))) return url.href;
    } catch {}
  }
  return null;
}
function moneyAmount(price) {
  if (!price) return null;
  const amount = Number(price.units ?? 0) + Number(price.nanos ?? 0) / 1e9;
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

export function productFrom(raw) {
  if (!raw || typeof raw.id !== 'string' || typeof raw.name !== 'string') return null;
  let url;
  try { url = new URL(raw.uri); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== 'www.officeworks.com.au' || !url.pathname.startsWith('/shop/officeworks/p/')) return null;
  const price = moneyAmount(raw.price);
  const currency = raw.price?.currencyCode === 'AUD' ? 'AUD' : null;
  const orig = raw.priceInfo?.originalPrice?.price;
  const origAmount = orig?.currencyCode === 'AUD' ? moneyAmount(orig) : null;
  const originalPrice = origAmount !== null && price !== null && origAmount > price ? origAmount : null;
  const agg = raw.ratingsAndReviews?.aggregateRatings;
  const rating = Number.isFinite(agg?.averageScore) && agg.averageScore > 0 && agg.averageScore <= 5 ? Math.round(agg.averageScore * 10) / 10 : null;
  const reviewCount = Number.isFinite(agg?.scoreCount) && agg.scoreCount > 0 ? Math.floor(agg.scoreCount) : null;
  const brand = typeof raw.brand === 'string' && raw.brand.trim() ? raw.brand.trim().slice(0, 80) : null;
  const availability = typeof raw.metadata?.availability === 'string' ? raw.metadata.availability.slice(0, 40) : null;
  return { id: raw.id.slice(0, 100), name: raw.name.slice(0, 180), url: url.href, price, currency, originalPrice, image: safeImage(raw), brand, rating, reviewCount, availability };
}

export function createOllie({ fetchImpl = fetch, state = 'NSW', postcode = '', timeoutMs = 55000 } = {}) {
  if (!['NSW','VIC','QLD','SA','WA','TAS','ACT','NT'].includes(state)) throw new Error('OFFICEWORKS_STATE must be an Australian state or territory code.');
  if (typeof postcode !== 'string') throw new Error('OFFICEWORKS_POSTCODE must be a four-digit string or left blank.');
  postcode = postcode.trim();
  if (postcode && !/^[0-9]{4}$/.test(postcode)) throw new Error('OFFICEWORKS_POSTCODE must contain exactly four digits or be left blank.');
  // The observed token API supports state only. Supply postcode as conversational
  // context, without inventing an API field or claiming verified local stock.
  const sessions = new Map(), busy = new Set();
  return {
    reset(key) {
      if (busy.has(key)) throw new OllieError('Wait for Ollie’s current reply before starting a new conversation.');
      sessions.delete(key);
    },
    async ask(key, question, location = { state, postcode }) {
      if (typeof question !== 'string' || !question.trim() || question.length > 3000) throw new OllieError('Ask a question between 1 and 3,000 characters.');
      const shoppingState = location.state, shoppingPostcode = location.postcode;
      if (!['NSW','VIC','QLD','SA','WA','TAS','ACT','NT'].includes(shoppingState) || typeof shoppingPostcode !== 'string' || (shoppingPostcode && !/^[0-9]{4}$/.test(shoppingPostcode))) throw new OllieError('The shopping location is invalid. Check the office mapping.');
      const locationKey = `${shoppingState}:${shoppingPostcode}`;
      const locationContext = shoppingPostcode ? `\n\nOffice location: ${shoppingState} ${shoppingPostcode}, Australia. Use this postcode when discussing nearby stores or delivery. If you cannot verify availability for this location, say so.` : '';
      if (busy.has(key)) throw new OllieError('Ollie is still answering your last question. Try again when it finishes.');
      busy.add(key);
      const signal = AbortSignal.timeout(timeoutMs);
      try {
        const now = Date.now();
        for (const [id, session] of sessions) if (now - session.touched > 3600_000) sessions.delete(id);
        if (!sessions.has(key) && sessions.size >= 500) sessions.delete(sessions.keys().next().value);
        const previous = sessions.get(key);
        // Changing office must not retain an Ollie conversation tied to another region.
        const session = previous?.locationKey === locationKey ? previous : { visitorId: `ow.${randomUUID()}`, touched: now, locationKey };
        // A token is acquired for our own anonymous session; no browser cookies or user account.
        const auth = await fetchImpl(TOKEN_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
          body: JSON.stringify({ visitorId: session.visitorId, userId: null, state: `W_${shoppingState}`, ...(session.sessionId ? { sessionId: session.sessionId } : {}) }),
        });
        if (!auth.ok) throw new OllieError(`Officeworks could not start a shopping session (HTTP ${auth.status}). Try again later.`);
        const credentials = await auth.json();
        if (!credentials.token || !credentials.sessionId) throw new OllieError('Officeworks did not return a shopping session.');
        session.sessionId = credentials.sessionId; session.touched = now; sessions.set(key, session);
        const response = await fetchImpl(CHAT_URL, {
          method: 'POST', signal,
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${credentials.token}`, 'X-Timezone': 'Australia/Sydney' },
          body: JSON.stringify({ clientId: CLIENT_ID, sessionId: session.sessionId,
            inputs: [{ text: `${question.trim()}${locationContext}\n\nPlease provide shopping recommendations and product links only. Do not add, remove or change cart items, or place an order.` }] }),
        });
        if (!response.ok) throw new OllieError(`Ollie is unavailable (HTTP ${response.status}). Please try again later.`);
        if (!response.headers.get('content-type')?.includes('text/event-stream')) throw new OllieError('Ollie returned an unexpected response format.');
        let text = '', actionRequested = false;
        const products = new Map();
        for await (const event of readEvents(response.body)) {
          const output = event.output ?? {};
          if (output.error) throw new OllieError('Ollie could not complete this request. Please try a different question.');
          for (const element of output.textBlock?.item?.elements ?? []) if (typeof element.text === 'string') text += element.text;
          for (const raw of output.productCollection?.products ?? []) { const product = productFrom(raw); if (product) products.set(product.id, product); }
          // No tool execution bridge: output from the external agent remains untrusted data.
          if (output.action || output.actions || output.functionCall || output.cartUpdate) actionRequested = true;
        }
        if (!text.trim() && !products.size) throw new OllieError('Ollie returned no recommendations. Try asking for a specific stationery item.');
        return { text: text.trim(), products: [...products.values()].slice(0, 12), actionRequested, checkedAt: new Date().toISOString() };
      } catch (error) {
        if (error instanceof OllieError) throw error;
        if (signal.aborted) throw new OllieError('Ollie took too long to reply. Please try again.');
        throw new OllieError('Could not reach Ollie. Please try again later.');
      } finally { busy.delete(key); }
    },
  };
}
