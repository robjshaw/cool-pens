import { randomUUID } from 'node:crypto';
import { CupboardError, shoppingLines } from './cupboard.js';
import { OllieError } from './ollie.js';
import { home, form, shopping, modal, section, mrkdwn, ollieBlocks } from './views.js';
import { locationSummary } from './locations.js';

const actor = args => ({ teamId: args.teamId, userId: args.userId });
const sessionKey = args => `${args.teamId}:${args.userId}`;
const safeMessage = error => error instanceof CupboardError || error instanceof OllieError ? error.message : 'Something went wrong. Please try again.';
export async function publish(args) {
  const { cupboard } = args.context;
  const state = await cupboard.read(actor(args));
  await args.client.views.publish({ user_id: args.userId, view: home(state, args.userId, cupboard.isOwner(args.userId), cupboard.ownerIds, args.context.cartHandoff.link(state.order)) });
}
async function open(args, view) {
  const method = args.payload.view?.type === 'modal' ? 'push' : 'open';
  await args.client.views[method]({ trigger_id: args.triggerId, view });
}
function saveSuggestions(args, result) {
  const cache = args.context.suggestions, now = Date.now();
  for (const [id, entry] of cache) if (now - entry.created > 3600_000) cache.delete(id);
  return result.products.map(product => {
    if (cache.size >= 1000) cache.delete(cache.keys().next().value);
    const id = randomUUID(); cache.set(id, { product, user: sessionKey(args), created: now }); return id;
  });
}
async function answer(args, question) {
  const location = await args.context.officeResolver.resolve(args);
  const result = await args.context.ollie.ask(sessionKey(args), question, location);
  return ollieBlocks(result, saveSuggestions(args, result), location);
}
function deferAnswer(args, question) {
  args.defer(async () => {
    try { await args.respond({ response_type: 'ephemeral', text: 'Stationery suggestions', blocks: await answer(args, question) }); }
    catch (error) { await args.respond(safeMessage(error)); }
  });
}
export async function command(args) {
  const { cupboard, ollie } = args.context;
  cupboard.authorize(actor(args));
  const text = (args.payload.text ?? '').trim();
  if (text === 'location') {
    args.defer(async () => { await args.respond(locationSummary(await args.context.officeResolver.resolve(args))); });
    return 'Checking your shopping location…';
  }
  if (text === 'new') { ollie.reset(sessionKey(args)); return 'Started a fresh search. Use /cupboard ask followed by what you’re looking for.'; }
  if (text.startsWith('ask ')) { deferAnswer(args, text.slice(4)); return 'Searching Officeworks…'; }
  if (text === 'help') return 'Use /cupboard to open your cupboard, /cupboard ask <question> to search for supplies, /cupboard location to check your shopping location, /cupboard list to review restocking, or /cupboard new to start a fresh search. All stock quantities count packs or units as sold.';
  const state = await cupboard.read(actor(args));
  if (['request', 'take', 'count', 'ask'].includes(text)) {
    cupboard.authorize(actor(args), text === 'count'); await open(args, form(text, state)); return;
  }
  if (text === 'list') { await open(args, shopping(state, cupboard.isOwner(args.userId), args.context.cartHandoff.link(state.order))); return; }
  if (text) return 'Try /cupboard ask <question>, /cupboard list, or /cupboard help.';
  return { response_type: 'ephemeral', text: 'Your stationery cupboard', blocks: home(state, args.userId, cupboard.isOwner(args.userId), cupboard.ownerIds, args.context.cartHandoff.link(state.order)).blocks };
}
export async function action(args) {
  const { cupboard } = args.context;
  cupboard.authorize(actor(args));
  const action = args.payload.actions[0], mode = action.action_id.slice('cupboard_'.length);
  if (mode.startsWith('link_')) return;
  if (mode === 'refresh') { args.defer(() => publish(args)); return 'Your App Home has been refreshed.'; }
  const state = await cupboard.read(actor(args));
  if (mode === 'new_chat') { args.context.ollie.reset(sessionKey(args)); await open(args, form('ask', state)); return; }
  if (['request','ask','take','count','remove'].includes(mode)) { cupboard.authorize(actor(args), mode === 'count' || mode === 'remove'); await open(args, form(mode, state)); return; }
  if (mode === 'list') { await open(args, shopping(state, cupboard.isOwner(args.userId), args.context.cartHandoff.link(state.order))); return; }
  if (mode === 'plan') {
    const lines = state.order?.lines ?? shoppingLines(state);
    const question = `Help source this shared office stationery cupboard list from Officeworks. Quantities are purchase packs or units as sold. Recommend suitable products and compare value; do not place an order.\n${lines.map(l => `${l.quantity} x ${l.name}`).join('\n')}`;
    if (question.length > 3000) { await open(args, modal('Find supplies', 'info', [section('This list is too long for one search. Try a few items at a time.')])); return; }
    await open(args, modal('Source this list', 'ask', [{ type: 'input', block_id: 'question', label: { type: 'plain_text', text: 'Review what to search for' }, element: { type: 'plain_text_input', action_id: 'value', multiline: true, max_length: 3000, initial_value: question } }], {}, 'Search')); return;
  }
  if (mode === 'receive' || mode === 'cancel_order') {
    cupboard.authorize(actor(args), true);
    await open(args, modal(mode === 'receive' ? 'Record delivery' : 'Cancel restock', mode, [section(mode === 'receive' ? 'Confirm that every purchase unit in this approved batch has arrived. Existing stock must be counted first. New requests made after approval stay open. Partial delivery is not supported in this MVP.' : 'Release this approved batch back to the request list. This does not cancel any order placed on Officeworks.')], { orderId: action.value }, mode === 'receive' ? 'All received' : 'Cancel batch')); return;
  }
  if (mode === 'suggestion') {
    const suggestion = args.context.suggestions.get(action.value);
    if (!suggestion || suggestion.user !== sessionKey(args) || Date.now() - suggestion.created > 3600_000) throw new CupboardError('This suggestion has expired. Please search again.');
    await cupboard.request(actor(args), { name: suggestion.product.name, product: suggestion.product, quantity: 1 }, `suggestion:${sessionKey(args)}:${action.value}`);
  } else if (mode === 'cancel_request') {
    try { await cupboard.cancelRequest(actor(args), action.value, `cancel:${action.value}`); }
    catch (error) {
      if (args.payload.view?.type === 'home' && args.triggerId) { await open(args, modal('Cupboard', 'info', [section(safeMessage(error))])); return; }
      throw error;
    }
  }
  else return;
  args.defer(async () => {
    if (mode === 'suggestion' && args.payload.view?.type === 'modal') {
      const owners = cupboard.ownerIds.map(id => `<@${id}>`).join(', ');
      const banner = { type: 'section', block_id: 'request_saved', text: mrkdwn(`✅ *Requested 1 pack* — sent to ${owners} for review.`) };
      await args.client.views.update({ view_id: args.payload.view.id, view: modal('Officeworks picks', 'info', [banner, ...args.payload.view.blocks.filter(b => b.block_id !== 'request_saved')]) });
    }
    await publish(args);
  });
  return mode === 'suggestion' ? 'Added 1 purchase pack / unit to the cupboard request list. Open App Home to see it.' : 'Request cancelled. Your App Home has been updated.';
}
export async function submission(args) {
  const { cupboard } = args.context;
  const view = args.payload.view;
  let metadata;
  try { metadata = JSON.parse(view.private_metadata); } catch { return { response_action: 'update', view: modal('Cupboard', 'info', [section('This form is invalid. Reopen /cupboard.')]) }; }
  const value = id => view.state?.values?.[id]?.value?.value ?? view.state?.values?.[id]?.value?.selected_option?.value;
  const key = `view:${args.teamId}:${view.id}`;
  try {
    cupboard.authorize(actor(args));
    if (metadata.mode === 'ask') {
      const question = value('question');
      if (!question?.trim() || question.length > 3000) throw new CupboardError('Enter a question up to 3,000 characters.');
      args.defer(async () => {
        let blocks;
        try { blocks = await answer(args, question); } catch (error) { blocks = [section(safeMessage(error))]; }
        await args.client.views.update({ view_id: view.id, view: modal('Officeworks picks', 'info', blocks) });
      });
      return { response_action: 'update', view: modal('Officeworks picks', 'info', [{ type: 'section', text: mrkdwn('✨ *Searching Officeworks…*\nThis usually takes a few seconds. Keep this window open for results.') }]) };
    }
    if (metadata.mode === 'request') await cupboard.request(actor(args), { name: value('name'), quantity: Number(value('quantity')) }, key);
    else if (metadata.mode === 'take') await cupboard.take(actor(args), value('item'), Number(value('quantity')), key);
    else if (metadata.mode === 'remove') await cupboard.removeItem(actor(args), value('item'), key);
    else if (metadata.mode === 'count') {
      if (value('onHand') == null || value('target') == null) throw new CupboardError('Enter both a stock count and a target.');
      await cupboard.count(actor(args), value('item'), Number(value('onHand')), Number(value('target')), key);
    } else if (metadata.mode === 'approve') await cupboard.approve(actor(args), metadata.revision, key);
    else if (['receive','cancel_order'].includes(metadata.mode)) await cupboard.finish(actor(args), metadata.orderId, metadata.mode === 'receive', key);
    else return;
    args.defer(() => publish(args));
    if (metadata.mode === 'approve') {
      const state = await cupboard.read(actor(args));
      return { response_action: 'update', view: shopping(state, true, args.context.cartHandoff.link(state.order)) };
    }
    return { response_action: 'update', view: modal('Saved', 'info', [section('Saved. Your cupboard App Home has been updated.')]) };
  } catch (error) {
    const editable = view.blocks.find(block => block.type === 'input');
    if (editable) return { response_action: 'errors', errors: { [editable.block_id]: safeMessage(error) } };
    return { response_action: 'update', view: modal('Cupboard', 'info', [section(safeMessage(error))]) };
  }
}
export async function homeView(args) {
  const { cupboard } = args.context;
  const state = await cupboard.read(actor(args));
  return home(state, args.userId, cupboard.isOwner(args.userId), cupboard.ownerIds, args.context.cartHandoff.link(state.order));
}
export function boundary({ error }) { return safeMessage(error); }
