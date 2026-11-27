import { createOllie } from '../lib/ollie.js';
const question = process.argv.slice(2).join(' ');
if (!question) { console.error('Usage: npm run ollie -- "Find great gel pens under $30"'); process.exit(1); }
try {
  const result = await createOllie({ state: process.env.OFFICEWORKS_STATE || 'NSW', postcode: process.env.OFFICEWORKS_POSTCODE || '' }).ask('cli', question);
  console.log(result.text);
  for (const product of result.products) console.log(`\n${product.name}\n${product.currency && product.price !== null ? `AUD $${product.price.toFixed(2)}` : 'Check current price'}\n${product.url}`);
  console.log('\nPrices returned by Ollie; confirm on Officeworks before buying.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
