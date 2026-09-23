const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const SCHEMA_VERSION = 1;

// The platform signs user-identity tokens with an RSA private key it never
// shares. Containers get only the PUBLIC half, so this app can verify who a
// user is but cannot mint an identity, and neither can any other app.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json());

// Centrally hosted platform assets, served by relative path from this app's
// own origin. Registered before the auth middleware because they are public.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

app.get(/^\/usernode-(?:bridge|native|tailwind)\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// Verify platform-issued JWT, then enforce auth on anything not public.
app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }

  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => {
  if (shuttingDown) return res.status(503).json({ status: 'draining' });
  res.json({ status: 'ok' });
});

app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

async function createSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_info (
      id INTEGER PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id BIGSERIAL PRIMARY KEY,
      sku VARCHAR(64) NOT NULL UNIQUE,
      name VARCHAR(255) NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
      stock_quantity INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      order_ref VARCHAR(64) NOT NULL UNIQUE,
      username VARCHAR(255) NOT NULL,
      user_id TEXT,
      status VARCHAR(32) NOT NULL DEFAULT 'placed',
      total_cents INTEGER NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_items (
      id BIGSERIAL PRIMARY KEY,
      order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id BIGINT NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventory_movements (
      id BIGSERIAL PRIMARY KEY,
      product_id BIGINT NOT NULL REFERENCES products(id),
      order_id BIGINT REFERENCES orders(id) ON DELETE SET NULL,
      delta INTEGER NOT NULL,
      reason VARCHAR(64) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query('CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders (created_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items (order_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_movements_product ON inventory_movements (product_id)');

  await pool.query(
    `INSERT INTO schema_info (id, schema_version)
     VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE
       SET schema_version = GREATEST(schema_info.schema_version, EXCLUDED.schema_version)`,
    [SCHEMA_VERSION]
  );
}

// Small, idempotent, obviously fake staging seed so the test panel is never
// blank. No-op outside staging.
async function seedStagingDemoData() {
  if (!IS_STAGING) return;

  await pool.query(
    `INSERT INTO products (sku, name, description, price_cents, stock_quantity, metadata)
     VALUES
       ('STAGING-DEMO-SKU-001', 'Staging demo Widget', 'Staging demo item, describes nothing real. Includes checkmark and 日本語.', 1250, 100,
         '{"seeded": true, "batch": "staging-demo"}'),
       ('STAGING-DEMO-SKU-002', 'Staging demo Gadget', 'Staging demo gadget with emoji: 🧰', 4500, 50,
         '{"seeded": true, "batch": "staging-demo"}'),
       ('STAGING-DEMO-SKU-003', 'Staging demo Gizmo', 'Staging demo gizmo, accented: café résumé', 990, 80,
         '{"seeded": true, "batch": "staging-demo"}')
     ON CONFLICT (sku) DO NOTHING`
  );

  await seedDeterministicOrders({
    seedKey: 'staging-demo',
    orders: 2,
    username: 'staging-demo-user',
  });
}

// mulberry32: small deterministic PRNG so the same seedKey always produces the
// same data, which makes before/after migration comparisons possible.
function makePrng(seedString) {
  let h = 1779033703 ^ seedString.length;
  for (let i = 0; i < seedString.length; i += 1) {
    h = Math.imul(h ^ seedString.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function seedDeterministicProducts({ seedKey, products }) {
  const rand = makePrng(seedKey + ':products');
  let created = 0;
  for (let i = 1; i <= products; i += 1) {
    const sku = `${seedKey}-SKU-${String(i).padStart(5, '0')}`;
    const name = `Seeded product ${i} (${seedKey})`;
    const description = `Deterministic seed ${seedKey} item ${i}. Includes checkmark, 日本語 and 🧪 for Unicode round trips.`;
    const price = 100 + Math.floor(rand() * 9900);
    const stock = 10 + Math.floor(rand() * 500);
    const metadata = JSON.stringify({ seedKey, index: i, generated: 'deterministic' });
    const res = await pool.query(
      `INSERT INTO products (sku, name, description, price_cents, stock_quantity, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (sku) DO NOTHING`,
      [sku, name, description, price, stock, metadata]
    );
    created += res.rowCount;
  }
  return created;
}

async function seedDeterministicOrders({ seedKey, orders, username = 'seed-generator' }) {
  const productRows = await pool.query(
    `SELECT id, price_cents FROM products WHERE sku LIKE $1 ORDER BY sku ASC LIMIT 50`,
    [`${seedKey}-SKU-%`]
  );
  const productPool = productRows.rows;
  if (!productPool.length) return { createdOrders: 0, createdItems: 0 };

  const rand = makePrng(seedKey + ':orders');
  let createdOrders = 0;
  let createdItems = 0;

  for (let i = 1; i <= orders; i += 1) {
    const orderRef = `${seedKey}-ORD-${String(i).padStart(6, '0')}`;
    const itemCount = 1 + Math.floor(rand() * 3);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const existing = await client.query('SELECT id FROM orders WHERE order_ref = $1', [orderRef]);
      if (existing.rowCount > 0) {
        await client.query('ROLLBACK');
        continue;
      }

      const lines = [];
      let total = 0;
      for (let j = 0; j < itemCount; j += 1) {
        const p = productPool[Math.floor(rand() * productPool.length)];
        const qty = 1 + Math.floor(rand() * 3);
        lines.push({ product: p, qty });
        total += qty * p.price_cents;
      }

      const orderRes = await client.query(
        `INSERT INTO orders (order_ref, username, user_id, total_cents, metadata)
         VALUES ($1, $2, NULL, $3, $4::jsonb)
         RETURNING id`,
        [orderRef, username, total, JSON.stringify({ seedKey, deterministic: true })]
      );
      const orderId = orderRes.rows[0].id;

      for (const line of lines) {
        await client.query(
          `INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents)
           VALUES ($1, $2, $3, $4)`,
          [orderId, line.product.id, line.qty, line.product.price_cents]
        );
        await client.query(
          `UPDATE products SET stock_quantity = stock_quantity - $1 WHERE id = $2`,
          [line.qty, line.product.id]
        );
        await client.query(
          `INSERT INTO inventory_movements (product_id, order_id, delta, reason)
           VALUES ($1, $2, $3, 'seed-order')`,
          [line.product.id, orderId, -line.qty]
        );
      }

      await client.query('COMMIT');
      createdOrders += 1;
      createdItems += lines.length;
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code !== '23505' && err.code !== '23514') throw err;
    } finally {
      client.release();
    }
  }
  return { createdOrders, createdItems };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

app.get('/api/products', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, sku, name, description, price_cents, stock_quantity, metadata
       FROM products ORDER BY id ASC LIMIT 100`
    );
    res.json({ products: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/orders', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const { rows } = await pool.query(
      `SELECT id, order_ref, username, status, total_cents, created_at
       FROM orders ORDER BY created_at DESC, id DESC LIMIT $1`,
      [limit]
    );
    res.json({ orders: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/orders/:ref', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, order_ref, username, status, total_cents, metadata, created_at
       FROM orders WHERE order_ref = $1`,
      [req.params.ref]
    );
    if (!rows.length) return res.status(404).json({ error: 'Order not found' });
    const items = await pool.query(
      `SELECT oi.id, oi.product_id, p.sku, oi.quantity, oi.unit_price_cents
       FROM order_items oi JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = $1 ORDER BY oi.id ASC`,
      [rows[0].id]
    );
    res.json({ order: rows[0], items: items.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Place an order: order header, items, stock decrements and movements all in
// ONE transaction. Any failure rolls the whole thing back.
app.post('/api/orders', async (req, res) => {
  const body = req.body || {};
  const items = Array.isArray(body.items) ? body.items : [];
  const orderRef = typeof body.orderRef === 'string' && body.orderRef.trim()
    ? body.orderRef.slice(0, 64)
    : `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  if (!items.length) return res.status(400).json({ error: 'items is required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const resolved = [];
    for (const item of items) {
      const productId = Number(item.productId);
      const quantity = Number(item.quantity);
      if (!Number.isInteger(productId) || !Number.isInteger(quantity) || quantity <= 0) {
        throw Object.assign(new Error('Each item needs a productId and a positive integer quantity'), { status: 400 });
      }
      const product = await client.query(
        `SELECT id, price_cents, stock_quantity FROM products WHERE id = $1 FOR UPDATE`,
        [productId]
      );
      if (!product.rowCount) {
        throw Object.assign(new Error(`Product ${productId} not found`), { status: 400 });
      }
      if (product.rows[0].stock_quantity < quantity) {
        throw Object.assign(
          new Error(`Insufficient stock for product ${productId}: requested ${quantity}, available ${product.rows[0].stock_quantity}`),
          { status: 409 }
        );
      }
      resolved.push({ product: product.rows[0], quantity });
    }

    const totalCents = resolved.reduce((sum, line) => sum + line.quantity * line.product.price_cents, 0);

    const orderRes = await client.query(
      `INSERT INTO orders (order_ref, username, user_id, total_cents, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (order_ref) DO NOTHING
       RETURNING id`,
      [orderRef, req.user.username, String(req.user.id), totalCents, JSON.stringify({ source: 'api' })]
    );

    if (!orderRes.rowCount) {
      const existing = await client.query('SELECT id FROM orders WHERE order_ref = $1', [orderRef]);
      await client.query('COMMIT');
      return res.json({ ok: true, duplicate: true, orderRef, orderId: existing.rows[0].id });
    }

    const orderId = orderRes.rows[0].id;
    for (const line of resolved) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents)
         VALUES ($1, $2, $3, $4)`,
        [orderId, line.product.id, line.quantity, line.product.price_cents]
      );
      await client.query(
        `UPDATE products SET stock_quantity = stock_quantity - $1 WHERE id = $2`,
        [line.quantity, line.product.id]
      );
      await client.query(
        `INSERT INTO inventory_movements (product_id, order_id, delta, reason)
         VALUES ($1, $2, $3, 'order-placed')`,
        [line.product.id, orderId, -line.quantity]
      );
    }

    await client.query('COMMIT');
    res.json({ ok: true, orderRef, orderId, totalCents });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    const status = err.status || 500;
    res.status(status).json({ error: err.message, rolledBack: true });
  } finally {
    client.release();
  }
});

// Deliberately failing transaction: proves rollback leaves no partial writes.
app.post('/api/test/failing-transaction', async (_req, res) => {
  const client = await pool.connect();
  const probeRef = `failprobe-${Date.now()}`;
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO orders (order_ref, username, total_cents) VALUES ($1, $2, 1)`,
      [probeRef, 'rollback-probe']
    );
    // Force an error after the write so the transaction must roll back.
    await client.query('SELECT 1 / 0');
    await client.query('COMMIT');
    return res.status(500).json({ error: 'Transaction unexpectedly committed' });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    const check = await client.query('SELECT id FROM orders WHERE order_ref = $1', [probeRef]);
    res.json({
      rolledBack: true,
      probeRef,
      error: err.message,
      rowsWrittenAfterRollback: check.rowCount,
    });
  } finally {
    client.release();
  }
});

// Deterministic seed generator for migration tests. Explicitly requested
// volumes; the staging boot seed stays small, this is the on-demand tool.
app.post('/api/seed', async (req, res) => {
  const body = req.body || {};
  const seedKey = typeof body.seedKey === 'string' && /^[a-zA-Z0-9_-]{1,32}$/.test(body.seedKey)
    ? body.seedKey
    : null;
  if (!seedKey) return res.status(400).json({ error: 'seedKey is required (letters, numbers, _ or -, max 32 chars)' });

  const products = Math.min(Math.max(parseInt(body.products, 10) || 0, 0), 500);
  const orders = Math.min(Math.max(parseInt(body.orders, 10) || 0, 0), 20000);

  try {
    const productResult = await seedDeterministicProducts({ seedKey, products });
    const orderResult = await seedDeterministicOrders({ seedKey, orders });
    res.json({
      ok: true,
      seedKey,
      requestedProducts: products,
      requestedOrders: orders,
      createdProducts: productResult,
      createdOrders: orderResult.createdOrders,
      createdItems: orderResult.createdItems,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/test-panel', async (_req, res) => {
  try {
    const version = await pool.query('SELECT schema_version FROM schema_info WHERE id = 1');
    const counts = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM products) AS products,
        (SELECT COUNT(*) FROM orders) AS orders,
        (SELECT COUNT(*) FROM order_items) AS order_items,
        (SELECT COUNT(*) FROM inventory_movements) AS movements
    `);
    const value = await pool.query('SELECT COALESCE(SUM(total_cents), 0) AS total_cents FROM orders');

    const orphans = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM order_items oi LEFT JOIN orders o ON o.id = oi.order_id WHERE o.id IS NULL) AS orphan_order_items,
        (SELECT COUNT(*) FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE p.id IS NULL) AS orphan_item_products,
        (SELECT COUNT(*) FROM inventory_movements m LEFT JOIN products p ON p.id = m.product_id WHERE p.id IS NULL) AS orphan_movements
    `);

    const stockMatch = await pool.query(`
      SELECT COUNT(*) AS mismatched FROM products p
      WHERE p.stock_quantity <> COALESCE((
        SELECT SUM(delta) FROM inventory_movements m WHERE m.product_id = p.id
      ), 0)
    `);

    const dupRefs = await pool.query(`
      SELECT COUNT(*) AS dupes FROM (
        SELECT order_ref FROM orders GROUP BY order_ref HAVING COUNT(*) > 1
      ) d
    `);

    const perms = await pool.query(`
      SELECT
        current_user AS current_user,
        session_user AS session_user,
        (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_super,
        has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_schema,
        pg_catalog.pg_get_userbyid(datdba) AS database_owner
      FROM pg_database WHERE datname = current_database()
    `);
    const ownsTables = await pool.query(`
      SELECT COUNT(*) AS foreign_owned FROM pg_tables
      WHERE schemaname = 'public' AND tableowner <> current_user
    `);

    const integrity = [
      { name: 'No orphan order items', ok: Number(orphans.rows[0].orphan_order_items) === 0, detail: `orphan items: ${orphans.rows[0].orphan_order_items}` },
      { name: 'No orphan item product refs', ok: Number(orphans.rows[0].orphan_item_products) === 0, detail: `orphan product refs: ${orphans.rows[0].orphan_item_products}` },
      { name: 'No orphan movements', ok: Number(orphans.rows[0].orphan_movements) === 0, detail: `orphan movements: ${orphans.rows[0].orphan_movements}` },
      { name: 'Stock matches movement ledger', ok: Number(stockMatch.rows[0].mismatched) === 0, detail: `products out of sync: ${stockMatch.rows[0].mismatched}` },
      { name: 'No duplicate order references', ok: Number(dupRefs.rows[0].dupes) === 0, detail: `duplicate refs: ${dupRefs.rows[0].dupes}` },
      { name: 'App user owns all app tables', ok: Number(ownsTables.rows[0].foreign_owned) === 0, detail: `tables owned by another role: ${ownsTables.rows[0].foreign_owned}` },
    ];

    res.json({
      schemaVersion: version.rows.length ? version.rows[0].schema_version : null,
      counts: {
        products: counts.rows[0].products,
        orders: counts.rows[0].orders,
        orderItems: counts.rows[0].order_items,
        movements: counts.rows[0].movements,
      },
      totalOrderValueCents: value.rows[0].total_cents,
      integrity,
      permissions: {
        currentUser: perms.rows[0].current_user,
        sessionUser: perms.rows[0].session_user,
        isSuperuser: perms.rows[0].is_super,
        canCreateSchema: perms.rows[0].can_create_schema,
        databaseOwner: perms.rows[0].database_owner,
      },
      note: 'pg_dump does not include cluster wide roles. After a restore, table ownership and GRANTs must be re-applied or app writes will fail.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  if (!req.user) {
    const deepPath = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_ORIGIN && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_ORIGIN + '/app/sv-staging-stockroom-d703d6/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits are not authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/sv-staging-stockroom-d703d6/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// Boot + graceful shutdown
// ---------------------------------------------------------------------------

const DRAIN_MS = 3000;
let shuttingDown = false;

async function start() {
  await createSchema();
  await seedStagingDemoData();
  const server = app.listen(port, () => console.log(`listening on :${port}`));
  server.keepAliveTimeout = 75_000;

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received, draining`);
    server.close(() => {});
    server.closeIdleConnections?.();
    const t = setTimeout(() => server.closeAllConnections?.(), DRAIN_MS);
    t.unref?.();
    try {
      await pool.end();
    } catch (e) {
      console.error('[shutdown] pool.end failed', e.message);
    }
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch(err => { console.error(err); process.exit(1); });
