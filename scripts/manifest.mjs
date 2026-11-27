import { spawnSync } from 'node:child_process';
import { parseOfficeLocations } from '../lib/locations.js';
const url = process.argv[2];
if (!url || !URL.canParse(url) || new URL(url).protocol !== 'https:') {
  console.error('Usage: npm run manifest -- https://YOUR-PUBLIC-HOST'); process.exit(1);
}
const result = spawnSync(process.execPath, ['node_modules/remack/bin/remack.js', 'manifest', '--url', new URL(url).origin, '--name', 'Cool Pens'], { encoding: 'utf8' });
if (result.status !== 0) { console.error(result.stderr); process.exit(1); }
const manifest = JSON.parse(result.stdout);
if (parseOfficeLocations(process.env.OFFICE_LOCATIONS).size || process.argv.includes('--office-locations')) {
  manifest.oauth_config.scopes.bot.push('users.profile:read');
}
manifest.display_information.description = 'Your office stationery cupboard, with Ollie at Officeworks.';
manifest.display_information.background_color = '#001080';
for (const command of manifest.features.slash_commands) {
  command.description = 'Manage the stationery cupboard or ask Ollie for recommendations';
  command.usage_hint = '[ask <question> | location | list | request | take | count | new | help]';
}
console.log(JSON.stringify(manifest, null, 2));
