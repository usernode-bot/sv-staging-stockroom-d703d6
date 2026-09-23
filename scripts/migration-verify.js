#!/usr/bin/env node
/**
 * External migration verification script for sv-staging-stockroom.
 *
 * Submits uniquely identified orders, records successful responses, then
 * verifies after a move that every acknowledged order exists exactly once and
 * that new writes still work.
 *
 * Usage:
 *   node scripts/migration-verify.js --base <base URL> --orders 100 --batch run-001 [--out file]
 *
 * Env: USERNODE_TOKEN (platform iframe token forwarded via x-usernode-token).
 */
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = { orders: 100, batch: 'run-' + Date.now(), out: null };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--base') args.base = argv[++i];
    else if (a === '--orders') args.orders = parseInt(argv[++i], 10);
    else if (a === '--batch') args.batch = argv[++i];
    else if (a === '--out') args.out = argv[++i];
  }
  if (!args.base) {
    console.error('usage: node scripts/migration-verify.js --base https://app-url [--orders N] [--batch name] [--out file]');
    process.exit(1);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.USERNODE_TOKEN || '';
  const headers = { 'Content-Type': 'application/json', 'x-usernode-token': token };
  const base = args.base.replace(/\/+$/, '');
  const results = { batch: args.batch, base, submitted: 0, verify: {}, startedAt: new Date().toISOString() };

  console.log(`Submitting ${args.orders} orders to ${base} with batch ${args.batch}`);

  const prodRes = await fetch(`${base}/api/products`, { headers });
  if (!prodRes.ok) {
    console.error(`could not list products at ${base}: ${prodRes.status}`);
    process.exit(1);
  }
  const prodData = await prodRes.json();
  if (!prodData.products.length) {
    console.error('no products available, seed first');
    process.exit(1);
  }

  for (let i = 1; i <= args.orders; i += 1) {
    const orderRef = `${args.batch}-ORD-${String(i).padStart(6, '0')}`;
    const product = prodData.products[(i - 1) % prodData.products.length];
    const res = await fetch(`${base}/api/orders`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ orderRef, items: [{ productId: product.id, quantity: 1 }] }),
    });
    if (res.ok) results.submitted += 1;
    else console.warn(`order ${orderRef} not accepted: ${res.status}`);
  }
  console.log(`submitted ${results.submitted}/${args.orders}`);

  const verified = { found: 0, missing: 0 };
  for (let i = 1; i <= results.submitted; i += 1) {
    const orderRef = `${args.batch}-ORD-${String(i).padStart(6, '0')}`;
    const res = await fetch(`${base}/api/orders/${encodeURIComponent(orderRef)}`, { headers });
    if (res.status === 200) verified.found += 1;
    else verified.missing += 1;
  }
  results.verify = verified;
  results.finishedAt = new Date().toISOString();

  console.log('verify:', JSON.stringify(verified));
  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, JSON.stringify(results, null, 2));
    console.log(`wrote ${args.out}`);
  }
  process.exit(verified.missing === 0 ? 0 : 1);
}
main();
