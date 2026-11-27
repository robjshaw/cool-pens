import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createOfficeResolver, parseOfficeLocations } from '../lib/locations.js';

const mapping = JSON.stringify({ Sydney: { state: 'NSW', postcode: '2000' }, Melbourne: { state: 'VIC', postcode: '3000' }, Darwin: { state: 'NT', postcode: '0800' } });
const env = { OFFICE_LOCATIONS: mapping, OFFICEWORKS_STATE: 'QLD', OFFICEWORKS_POSTCODE: '4000' };
function client(fields, profile) {
  const calls = [];
  return { calls, call: async (method, { user }) => {
    if (method === 'team.profile.get') { calls.push('schema'); return { ok: true, profile: { fields } }; }
    assert.equal(method, 'users.profile.get'); calls.push(user);
    return { ok: true, profile: { fields: { Xoffice: { value: profile[user] } }, email: 'must-not-be-forwarded@example.test' } };
  } };
}
test('office lookup normalises names, caches only mapped locations and refreshes changes', async () => {
  let now = 0;
  const values = { U1: '  sYDneY  ', U2: 'Darwin' }, api = client([{ id: 'Xoffice', label: 'Office Location' }], values);
  const resolver = createOfficeResolver({ env, now: () => now });
  const args = { client: api, teamId: 'T1', userId: 'U1' };
  assert.deepEqual(await resolver.resolve(args), { label: 'Sydney', state: 'NSW', postcode: '2000', source: 'slack' });
  await resolver.resolve(args); assert.deepEqual(api.calls, ['schema', 'U1']);
  assert.equal((await resolver.resolve({ ...args, userId: 'U2' })).postcode, '0800');
  values.U1 = 'Melbourne'; now = 300_001;
  assert.equal((await resolver.resolve(args)).postcode, '3000');
});
test('explicit field ID bypasses schema lookup and missing offices use fallback', async () => {
  const api = client([], { U1: 'Unknown', U2: '' });
  const resolver = createOfficeResolver({ env: { ...env, SLACK_OFFICE_FIELD_ID: 'Xoffice' } });
  for (const userId of ['U1', 'U2']) {
    const location = await resolver.resolve({ client: api, teamId: 'T', userId });
    assert.equal(location.source, 'default'); assert.equal(location.postcode, '4000');
  }
  assert.ok(!api.calls.includes('schema'));
});
test('ambiguous or hidden fields are not guessed', async () => {
  for (const fields of [[{ id: 'a', label: 'Office' }, { id: 'b', label: 'Location' }], [{ id: 'a', label: 'Office', is_hidden: true }]]) {
    const api = client(fields, {}), resolver = createOfficeResolver({ env });
    const result = await resolver.resolve({ client: api, teamId: 'T', userId: 'U' });
    assert.equal(result.source, 'default'); assert.match(result.reason, /SLACK_OFFICE_FIELD_ID/);
    assert.deepEqual(api.calls, ['schema']);
  }
});
test('disabled mapping makes no API calls, and errors or slow Slack calls fall back', async () => {
  const api = client([], {});
  await createOfficeResolver({ env: {} }).resolve({ client: api, teamId: 'T', userId: 'U' });
  assert.deepEqual(api.calls, []);
  for (const get of [async () => { throw new Error('missing_scope'); }, () => new Promise(() => {})]) {
    const resolver = createOfficeResolver({ env, timeoutMs: 5 });
    const result = await resolver.resolve({ client: { call: get }, teamId: 'T', userId: 'U' });
    assert.equal(result.postcode, '4000'); assert.match(result.reason, /lookup is unavailable/);
  }
});
test('bad mappings fail at startup and postcode strings retain leading zeros', () => {
  for (const raw of ['not json', '[]', 'null', '{"A":{"state":"NT","postcode":800}}', '{"A":{"state":"INVALID","postcode":"2000"}}', '{"Sydney":{"state":"NSW","postcode":"2000"},"SYDNEY":{"state":"NSW","postcode":"2000"}}']) assert.throws(() => parseOfficeLocations(raw), /OFFICE_LOCATIONS/);
  assert.equal(parseOfficeLocations(mapping).get('darwin').postcode, '0800');
});
test('profile scope is only included when office lookup is requested', () => {
  for (const enabled of [false, true]) {
    const output = execFileSync(process.execPath, ['scripts/manifest.mjs', 'https://example.com', ...(enabled ? ['--office-locations'] : [])], { env: { ...process.env, OFFICE_LOCATIONS: '{}' }, encoding: 'utf8' });
    assert.equal(JSON.parse(output).oauth_config.scopes.bot.includes('users.profile:read'), enabled);
  }
});
