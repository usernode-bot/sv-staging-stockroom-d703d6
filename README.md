# sv-staging-stockroom

A small inventory-and-orders app used to exercise underlying database
changes on the Homeroom platform: schema application, data restore,
ownership, permissions and rollback behaviour.

## What it tests

| Feature | Why it matters |
|---|---|
| Foreign keys, unique SKUs, stock constraints | Relationships and constraints survive restoration |
| Generated IDs and timestamps | Sequences continue correctly; values stay intact |
| Transactional orders | No partially completed writes during a cutover |
| JSON metadata and Unicode descriptions | More than simple integer/string data survives |
| Deterministic seed generator | Repeatable tests, starting small and scaling up |
| Ownership and permissions panel | pg_dump does not include cluster wide roles |

## Data model

Four tables: `products`, `orders`, `order_items` and `inventory_movements`.
Placing an order writes the order header, its items, stock decrements and
movement ledger rows in a single transaction.

## Test panel

The panel shows schema version, row counts, total order value, integrity
check results and the current database user/ownership context. It includes a
deliberate failing transaction to verify rollback leaves no partial writes.

## Deterministic seed generator

`POST /api/seed` with a `seedKey`, a product count and an order count. The
same key always produces the same data, so before/after migration snapshots
are comparable. Start small (around 100 products and 10,000 orders), then
scale up once the shared → dedicated → shared round trip is reliable.

## Migration runbook

For the actual migration tests, deploy two copies of this app:

- **Mover:** shared → dedicated → shared.
- **Canary:** stays on shared and keeps accepting writes throughout, proving
  that moving another app does not disrupt it.

An external script submits uniquely identified orders and records successful
responses. After each move, verify every acknowledged order exists exactly
once, new writes work, and the old database no longer accepts app writes.

`pg_dump` does not include cluster wide roles, so restoring data alone is
insufficient: table ownership and GRANTs must be re-applied or the app will
fail to write. The test panel surfaces the current user and ownership state
so this is visible after any restore.

## Stack

Node.js / Express, Postgres, precompiled Tailwind. Schema is applied
idempotently on boot.
