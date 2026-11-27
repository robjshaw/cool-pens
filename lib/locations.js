const states = new Set(['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'ACT', 'NT']);
const normalise = text => text.trim().replace(/\s+/g, ' ').toLowerCase();

export function parseOfficeLocations(raw = '') {
  let entries;
  try { entries = JSON.parse(raw.trim() || '{}'); } catch { throw new Error('OFFICE_LOCATIONS must be a JSON object mapping office names to state and postcode.'); }
  if (!entries || Array.isArray(entries) || typeof entries !== 'object') throw new Error('OFFICE_LOCATIONS must be a JSON object.');
  const map = new Map();
  for (const [label, location] of Object.entries(entries)) {
    const name = normalise(label);
    if (!name || label.length > 100 || map.has(name)) throw new Error('OFFICE_LOCATIONS office names must be unique and between 1 and 100 characters.');
    if (!location || !states.has(location.state) || typeof location.postcode !== 'string' || !/^[0-9]{4}$/.test(location.postcode)) throw new Error(`OFFICE_LOCATIONS entry ${label} needs a state and a four-digit postcode string.`);
    map.set(name, { label: label.trim(), state: location.state, postcode: location.postcode });
  }
  return map;
}

async function bounded(work, timeoutMs) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('profile_timeout')), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

export function createOfficeResolver({ env, now = Date.now, timeoutMs = 5000 }) {
  const offices = parseOfficeLocations(env.OFFICE_LOCATIONS);
  const fieldId = env.SLACK_OFFICE_FIELD_ID?.trim();
  const fallback = { state: env.OFFICEWORKS_STATE || 'NSW', postcode: env.OFFICEWORKS_POSTCODE?.trim() || '', source: 'default' };
  const profiles = new Map(), schemas = new Map();
  async function findField(client, teamId) {
    if (fieldId) return fieldId;
    let schema = schemas.get(teamId);
    if (!schema || schema.expires <= now()) {
      const response = await client.call('team.profile.get', {}, { encoding: 'form' });
      if (!response.ok) throw new Error('profile_schema_unavailable');
      const candidates = (response.profile?.fields ?? []).filter(field => !field.is_hidden && typeof field.label === 'string' && ['office', 'location', 'office location'].includes(normalise(field.label)));
      schema = { id: candidates.length === 1 ? candidates[0].id : null, expires: now() + 300_000 };
      schemas.set(teamId, schema);
    }
    return schema.id;
  }
  return {
    enabled: offices.size > 0,
    async resolve({ client, teamId, userId }) {
      if (!offices.size) return { ...fallback, reason: 'Office mapping is not configured.' };
      const key = `${teamId}:${userId}`, cached = profiles.get(key);
      if (cached && cached.expires > now()) return { ...cached.value };
      let value;
      try {
        value = await bounded((async () => {
          const id = await findField(client, teamId);
          if (!id) return { ...fallback, reason: 'Set SLACK_OFFICE_FIELD_ID: no unique Office or Location profile field was found.' };
          const response = await client.call('users.profile.get', { user: userId }, { encoding: 'form' });
          if (!response.ok) throw new Error('profile_unavailable');
          const office = response.profile?.fields?.[id]?.value;
          const match = typeof office === 'string' ? offices.get(normalise(office)) : null;
          return match ? { ...match, source: 'slack' } : { ...fallback, reason: 'Your Slack office field is blank or has no configured postcode mapping.' };
        })(), timeoutMs);
      } catch {
        value = { ...fallback, reason: 'Slack office lookup is unavailable. Check users.profile:read permission and the configured profile field.' };
      }
      if (profiles.size >= 1000) profiles.delete(profiles.keys().next().value);
      // Retain only the mapped office, never the rest of the Slack profile.
      profiles.set(key, { value, expires: now() + (value.source === 'slack' ? 300_000 : 30_000) });
      return { ...value };
    },
  };
}

export function locationSummary(location) {
  const where = [location.state, location.postcode].filter(Boolean).join(' ');
  return location.source === 'slack'
    ? `Shopping location: ${location.label} · ${where} (from your Slack office).`
    : `Shopping location: ${where} (configured fallback). ${location.reason}`;
}
