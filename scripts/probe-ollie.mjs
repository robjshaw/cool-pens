// Inspect public configuration and obtain a new, anonymous shopping session.
// Never prints or persists bearer tokens, cookies, or session identifiers.
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const response = await fetch('https://www.officeworks.com.au/app/header/api/cart/get-token', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ visitorId: `ow.${randomUUID()}`, userId: null, state: 'W_NSW' }),
  signal: AbortSignal.timeout(30000),
});
console.log('anonymous token endpoint status:', response.status);
const result = await response.json();
console.log('response keys:', Object.keys(result));
console.log('has token:', Boolean(result.token), 'has session:', Boolean(result.sessionId));
if (!response.ok || !result.token) process.exit(1);
const configResponse = await fetch('https://agenticapplications.googleapis.com/v1/sales:retrieveConfig', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${result.token}` },
  body: JSON.stringify({ name: 'projects/agentis-commerce-corp-dev/locations/prod/salesAgentConfigs/llsudioqpaq1qjku' }),
  signal: AbortSignal.timeout(30000),
});
console.log('authenticated config status:', configResponse.status);
const config = await configResponse.json();
// Public UI configuration only; redact fields that might carry session credentials.
await writeFile('research/config-response.json', JSON.stringify(config, (key, value) => /token|secret|apiKey|sessionId/i.test(key) ? '[redacted]' : value, 2));
console.log('config top-level keys:', Object.keys(config));
if (!configResponse.ok) process.exit(1);
const service = JSON.parse(config.payload.settings.service);
console.log('merchant client:', service.commerceAiClientId);
const chatResponse = await fetch('https://agenticapplications.googleapis.com/v1/sales:executeChat?alt=sse', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${result.token}`, 'X-Timezone': 'Australia/Sydney' },
  body: JSON.stringify({ clientId: service.commerceAiClientId, sessionId: result.sessionId, inputs: [{ text: 'Suggest two good everyday gel pen multipacks for a shared office stationery cupboard. Include product links and pack sizes. Recommendations only; do not add anything to a cart.' }] }),
  signal: AbortSignal.timeout(60000),
});
console.log('chat status:', chatResponse.status, 'content-type:', chatResponse.headers.get('content-type'));
const events = [];
for (const line of (await chatResponse.text()).split('\n')) {
  if (line.startsWith('data:')) {
    try { events.push(JSON.parse(line.slice(5))); } catch {}
  }
}
await writeFile('research/chat-response.json', JSON.stringify(events, (key, value) => /token|secret|apiKey|sessionId/i.test(key) ? '[redacted]' : value, 2));
console.log('chat events:', events.length, 'event keys:', [...new Set(events.flatMap(Object.keys))]);
