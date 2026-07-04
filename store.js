// store.js — persistent storage for cage accounts + audit history.
//
// Backend is picked automatically:
//   - Postgres (PgStore) when process.env.DATABASE_URL is set. This is what
//     Railway's Postgres plugin injects, and it's what makes the ledger and
//     game-history survive redeploys.
//   - A local JSON file (JsonStore) otherwise, so `node table-server.js`
//     still runs with zero setup for local dev and the test suite.
//
// Both expose the same async interface:
//   init()                         -> Map<token, account>   (bulk load at boot)
//   upsertAccount(token, account)  -> persist a full account snapshot
//   deleteAccount(token)           -> remove an account (history rows survive)
//   logTransaction(entry)          -> append one money-movement row
//   logHand(entry)                 -> append one played-hand row
//   getHistory(token, limit)       -> { transactions, hands }
//
// account shape: { name, cash, comps, no, pin }
// transaction entry: { token, type, amount, balanceAfter, tableCode, note }
// hand entry: { token, tableCode, round, bet, result, payout }

'use strict';
const fs = require('fs');
const path = require('path');

function create() {
  if (process.env.DATABASE_URL) return new PgStore(process.env.DATABASE_URL);
  return new JsonStore(
    process.env.TABLE_CAGE_FILE || path.join(__dirname, 'cage-data.json'),
    process.env.TABLE_HISTORY_FILE || path.join(__dirname, 'cage-history.json')
  );
}

// ---------------------------------------------------------------- JsonStore
// Local/dev fallback. Debounced disk writes, capped history length.
class JsonStore {
  constructor(accountsFile, historyFile) {
    this.accountsFile = accountsFile;
    this.historyFile = historyFile;
    this.accounts = new Map();
    this.transactions = [];
    this.hands = [];
    this.saveTimer = null;
    this.MAX_HISTORY = 20000;
  }

  async init() {
    try {
      const data = JSON.parse(fs.readFileSync(this.accountsFile, 'utf8'));
      for (const [token, acc] of Object.entries(data)) this.accounts.set(token, acc);
      console.log('  [store] JSON ledger loaded: ' + this.accounts.size + ' account(s).');
    } catch (e) { /* first run */ }
    try {
      const h = JSON.parse(fs.readFileSync(this.historyFile, 'utf8'));
      this.transactions = Array.isArray(h.transactions) ? h.transactions : [];
      this.hands = Array.isArray(h.hands) ? h.hands : [];
    } catch (e) { /* first run */ }
    return this.accounts;
  }

  async upsertAccount(token, acc) {
    this.accounts.set(token, acc);
    this._saveSoon();
  }

  async deleteAccount(token) {
    this.accounts.delete(token);
    this._saveSoon();
  }

  async logTransaction(entry) {
    this.transactions.push(Object.assign({ created_at: new Date().toISOString() }, entry));
    if (this.transactions.length > this.MAX_HISTORY) this.transactions.splice(0, this.transactions.length - this.MAX_HISTORY);
    this._saveSoon();
  }

  async logHand(entry) {
    this.hands.push(Object.assign({ created_at: new Date().toISOString() }, entry));
    if (this.hands.length > this.MAX_HISTORY) this.hands.splice(0, this.hands.length - this.MAX_HISTORY);
    this._saveSoon();
  }

  async getHistory(token, limit) {
    limit = limit || 100;
    // return the same snake_case shape PgStore does, so the admin UI is
    // backend-agnostic
    const tx = this.transactions.filter(t => t.token === token).slice(-limit).reverse().map(t => ({
      type: t.type, amount: t.amount, balance_after: t.balanceAfter,
      table_code: t.tableCode || null, note: t.note || null, created_at: t.created_at
    }));
    const hd = this.hands.filter(h => h.token === token).slice(-limit).reverse().map(h => ({
      table_code: h.tableCode || null, round: h.round, bet: h.bet,
      result: h.result, payout: h.payout, created_at: h.created_at
    }));
    return { transactions: tx, hands: hd };
  }

  _saveSoon() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const accData = {};
      for (const [token, acc] of this.accounts) accData[token] = acc;
      fs.writeFile(this.accountsFile, JSON.stringify(accData, null, 1), () => {});
      fs.writeFile(this.historyFile, JSON.stringify({ transactions: this.transactions, hands: this.hands }), () => {});
    }, 800);
  }
}

// ------------------------------------------------------------------ PgStore
// Production backend: Railway Postgres (or any Postgres via DATABASE_URL).
class PgStore {
  constructor(connectionString) {
    const { Pool } = require('pg');
    // Railway's internal/private database hostname (…​.railway.internal) and
    // local Postgres speak plaintext; the public proxy URL requires TLS. Pick
    // SSL by host so a first deploy works whichever URL you wired up.
    let host = '';
    try { host = new URL(connectionString).hostname; } catch (e) {}
    const noSsl = /localhost|127\.0\.0\.1|\.railway\.internal$/.test(host);
    this.pool = new Pool({
      connectionString,
      ssl: noSsl ? false : { rejectUnauthorized: false }
    });
  }

  async init() {
    // Private networking often isn't resolvable in the first second after the
    // container starts, so retry the initial connection a few times before
    // giving up — otherwise a normal cold start would crash-loop the app.
    let lastErr = null;
    for (let attempt = 1; attempt <= 8; attempt++) {
      try { await this.pool.query('SELECT 1'); lastErr = null; break; }
      catch (e) {
        lastErr = e;
        console.error('  [store] Postgres not ready (attempt ' + attempt + '/8): ' + (e.message || e));
        await new Promise(r => setTimeout(r, Math.min(3000, attempt * 600)));
      }
    }
    if (lastErr) throw lastErr;

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        token TEXT PRIMARY KEY,
        player_no TEXT UNIQUE NOT NULL,
        pin TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        cash NUMERIC NOT NULL DEFAULT 0,
        comps INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        token TEXT NOT NULL,
        type TEXT NOT NULL,
        amount NUMERIC NOT NULL,
        balance_after NUMERIC NOT NULL,
        table_code TEXT,
        note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_transactions_token ON transactions(token, created_at DESC)`);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS hands (
        id SERIAL PRIMARY KEY,
        token TEXT NOT NULL,
        table_code TEXT,
        round INTEGER,
        bet NUMERIC,
        result TEXT,
        payout NUMERIC,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_hands_token ON hands(token, created_at DESC)`);

    const { rows } = await this.pool.query('SELECT * FROM accounts');
    const map = new Map();
    for (const r of rows) {
      map.set(r.token, {
        name: r.name || '', cash: Number(r.cash), comps: r.comps || 0,
        no: r.player_no, pin: r.pin
      });
    }
    console.log('  [store] Postgres ledger loaded: ' + map.size + ' account(s).');
    return map;
  }

  async upsertAccount(token, acc) {
    await this.pool.query(
      `INSERT INTO accounts (token, player_no, pin, name, cash, comps, created_at, last_seen)
       VALUES ($1,$2,$3,$4,$5,$6, now(), now())
       ON CONFLICT (token) DO UPDATE SET
         player_no = EXCLUDED.player_no, pin = EXCLUDED.pin, name = EXCLUDED.name,
         cash = EXCLUDED.cash, comps = EXCLUDED.comps, last_seen = now()`,
      [token, acc.no, acc.pin, acc.name || '', acc.cash, acc.comps || 0]
    );
  }

  async deleteAccount(token) {
    await this.pool.query('DELETE FROM accounts WHERE token = $1', [token]);
  }

  async logTransaction(entry) {
    await this.pool.query(
      `INSERT INTO transactions (token, type, amount, balance_after, table_code, note)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [entry.token, entry.type, entry.amount, entry.balanceAfter, entry.tableCode || null, entry.note || null]
    );
  }

  async logHand(entry) {
    await this.pool.query(
      `INSERT INTO hands (token, table_code, round, bet, result, payout)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [entry.token, entry.tableCode || null, entry.round || null, entry.bet, entry.result, entry.payout]
    );
  }

  async getHistory(token, limit) {
    limit = limit || 100;
    const tx = await this.pool.query(
      'SELECT type, amount, balance_after, table_code, note, created_at FROM transactions WHERE token=$1 ORDER BY created_at DESC LIMIT $2',
      [token, limit]
    );
    const hd = await this.pool.query(
      'SELECT table_code, round, bet, result, payout, created_at FROM hands WHERE token=$1 ORDER BY created_at DESC LIMIT $2',
      [token, limit]
    );
    return { transactions: tx.rows, hands: hd.rows };
  }
}

module.exports = { create };
