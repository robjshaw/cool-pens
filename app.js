import { createApp, fileStorage, serve } from 'remack';
import { pathToFileURL } from 'node:url';
import { createCupboard } from './lib/cupboard.js';
import { createOllie } from './lib/ollie.js';
import { createOfficeResolver } from './lib/locations.js';
import { createCartHandoff } from './lib/cart-handoff.js';

export function buildApp({ env = process.env, storage, ollie, logger } = {}) {
  for (const name of ['SLACK_SIGNING_SECRET', 'SLACK_BOT_TOKEN', 'SLACK_TEAM_ID', 'CUPBOARD_OWNER_IDS']) {
    if (!env[name]?.trim()) throw new Error(`Missing ${name}. See .env.example and README.md.`);
  }
  storage ??= fileStorage(env.DATA_FILE || './data/cupboard.json');
  const cupboard = createCupboard({ storage, teamId: env.SLACK_TEAM_ID, ownerIds: env.CUPBOARD_OWNER_IDS.split(',').map(s => s.trim()).filter(Boolean) });
  const cartHandoff = createCartHandoff({ env, cupboard });
  const app = createApp({ env, storage, routes: new URL('./routes/', import.meta.url), logger,
    context: { cupboard, cartHandoff, ollie: ollie ?? createOllie({ state: env.OFFICEWORKS_STATE || 'NSW', postcode: env.OFFICEWORKS_POSTCODE || '' }), officeResolver: createOfficeResolver({ env }), suggestions: new Map() } });
  const fetch = async request => new URL(request.url).pathname === '/healthz' ? new Response('ok') : await cartHandoff.fetch(request) ?? app.fetch(request);
  return { app, cupboard, cartHandoff, fetch };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { app, fetch } = buildApp(); await app.ready;
  const server = await serve({ port: Number(process.env.PORT || 3000), onIdle: app.idle,
    fetch });
  console.log(`Cool Pens listening on ${server.url}. Slack endpoint: /events`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await server.close(); process.exit(0); });
}
