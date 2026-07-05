// TABLE SEVEN — private multiplayer blackjack casino with a strategy coach.
// Zero dependencies: plain Node.js (>=18). Run locally with:
//   node table-server.js            (or double-click Start-TableSeven.cmd)
// Deploys anywhere that runs Node (Railway, etc.) — it honors process.env.PORT.
//
// The casino:
//   - THE CAGE: every visitor gets a persistent account (cage-data.json).
//     New players are staked $1,000. Buy chips into a table, color up when you
//     leave — winnings survive between sessions.
//   - TABLES: rooms with 4-char codes. The first human to sit is the HOST and
//     can add bots and set the rules (payout 3:2 or 6:5, decks, dealer soft 17,
//     double-after-split, surrender). Public tables show in the lobby; private
//     ones are join-by-code only.
//   - WEBSOCKETS: hand-rolled RFC-6455 server (no npm packages). State pushes
//     instantly; close a tab and the table banks your chips and frees the seat.

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const store = require('./store');

const PORT = process.env.PORT || 7777;
const FAST = !!process.env.TABLE_FAST;          // used by automated tests
const DEALER_MS = FAST ? 0 : 800;               // dealer draw cadence
const BOT_MS = FAST ? 5 : 750;                  // bot "thinking" delay
const TURN_TIMEOUT_MS = FAST ? 3600000 : 45000; // auto-stand a present-but-idle player
const INS_TIMEOUT_MS = FAST ? 3600000 : 30000;
const PRESENCE_MS = Number(process.env.TABLE_PRESENCE_MS) || (FAST ? 3600000 : 12000);
const ROOM_IDLE_MS = FAST ? 3600000 : 20 * 60000;
const MAX_ROOMS = 50;
const MAX_SEATS = 6;
// rate limiting: relaxed to near-unlimited under FAST (automated tests) so
// gameplay volume never trips it; a dedicated test overrides these via env
// to prove the 429 path actually works.
const RATE_WINDOW_MS = 60000;
const RATE_LOGIN_MAX = Number(process.env.TABLE_RATE_LOGIN_MAX) || (FAST ? 1e9 : 10);
const RATE_JOIN_MAX = Number(process.env.TABLE_RATE_JOIN_MAX) || (FAST ? 1e9 : 20);
const RATE_GAMEPLAY_MAX = Number(process.env.TABLE_RATE_GAMEPLAY_MAX) || (FAST ? 1e9 : 120);
const START_CASH = 1000;   // the cage stakes every new player
const COMP_CASH = 500;     // pity stake when you go broke
const ROOT = __dirname;

// Pit Boss key: set TABLE_ADMIN_KEY for a stable key (e.g. on Railway);
// otherwise a fresh one is generated and printed at boot.
const ADMIN_KEY = process.env.TABLE_ADMIN_KEY || crypto.randomBytes(6).toString('hex');

// The owner master key (env TABLE_ADMIN_KEY) always unlocks and can manage
// staff. Staff admins are username+password rows in the DB (see admins map).
function isMasterKey(key) {
  const a = crypto.createHash('sha256').update(String(key || '')).digest();
  const b = crypto.createHash('sha256').update(ADMIN_KEY).digest();
  return crypto.timingSafeEqual(a, b);
}

// ----- staff admin accounts + sessions -----
const admins = new Map();   // username -> { hash, salt }
const adminSessions = new Map(); // sessionToken -> { who, isOwner, expiresAt }
const ADMIN_SESSION_MS = 8 * 60 * 60 * 1000;

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return { hash, salt };
}
function verifyPassword(password, rec) {
  if (!rec || !rec.salt || !rec.hash) return false;
  const a = Buffer.from(crypto.scryptSync(String(password), rec.salt, 32).toString('hex'));
  const b = Buffer.from(rec.hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function newSession(who, isOwner) {
  const t = crypto.randomBytes(24).toString('hex');
  adminSessions.set(t, { who, isOwner, expiresAt: Date.now() + ADMIN_SESSION_MS });
  return t;
}
// returns the session record if the request carries a valid session token OR
// the owner master key; else null
function adminAuth(body) {
  if (body && body.session) {
    const s = adminSessions.get(String(body.session));
    if (s && s.expiresAt > Date.now()) return s;
  }
  if (body && body.key && isMasterKey(body.key)) return { who: 'owner', isOwner: true, expiresAt: Infinity };
  return null;
}
setInterval(() => {
  const now = Date.now();
  for (const [t, s] of adminSessions) if (s.expiresAt < now) adminSessions.delete(t);
}, 10 * 60000).unref();

// ---------- blackjack engine ----------
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = [
  { r: 'A', v: 11 }, { r: '2', v: 2 }, { r: '3', v: 3 }, { r: '4', v: 4 },
  { r: '5', v: 5 }, { r: '6', v: 6 }, { r: '7', v: 7 }, { r: '8', v: 8 },
  { r: '9', v: 9 }, { r: '10', v: 10 }, { r: 'J', v: 10 }, { r: 'Q', v: 10 }, { r: 'K', v: 10 }
];

function buildShoe(decks) {
  const shoe = [];
  for (let d = 0; d < decks; d++)
    for (const s of SUITS)
      for (const rk of RANKS) shoe.push({ r: rk.r, v: rk.v, s });
  for (let i = shoe.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shoe[i], shoe[j]] = [shoe[j], shoe[i]];
  }
  return shoe;
}

function handValue(cards) {
  let total = 0, aces = 0;
  for (const c of cards) {
    if (c.r === 'A') { aces++; total += 1; } else total += c.v;
  }
  let soft = false;
  if (aces > 0 && total + 10 <= 21) { total += 10; soft = true; }
  return { total, soft };
}

function isBlackjack(cards) {
  return cards.length === 2 && handValue(cards).total === 21;
}

function fmt(n) { return (n % 1 === 0) ? '$' + n : '$' + n.toFixed(2); }

// Multi-deck H17 basic strategy (used by bots). Returns 'H'|'S'|'D'|'P'.
function basicStrategy(cards, up, canDouble, canSplit) {
  const hv = handValue(cards);
  const t = hv.total;
  if (canSplit && cards.length === 2 && cards[0].v === cards[1].v) {
    const p = cards[0].v;
    if (p === 11 || p === 8) return 'P';
    if (p === 9 && up !== 7 && up !== 10 && up !== 11) return 'P';
    if (p === 7 && up <= 7) return 'P';
    if (p === 6 && up <= 6) return 'P';
    if (p === 4 && (up === 5 || up === 6)) return 'P';
    if ((p === 3 || p === 2) && up <= 7) return 'P';
  }
  if (hv.soft) {
    if (t >= 20) return 'S';
    if (t === 19) return (up === 6 && canDouble) ? 'D' : 'S';
    if (t === 18) { if (up <= 6) return canDouble ? 'D' : 'S'; if (up <= 8) return 'S'; return 'H'; }
    if (t === 17) return (up >= 3 && up <= 6 && canDouble) ? 'D' : 'H';
    if (t >= 15) return (up >= 4 && up <= 6 && canDouble) ? 'D' : 'H';
    return (up >= 5 && up <= 6 && canDouble) ? 'D' : 'H';
  }
  if (t <= 8) return 'H';
  if (t === 9) return (up >= 3 && up <= 6 && canDouble) ? 'D' : 'H';
  if (t === 10) return (up <= 9 && canDouble) ? 'D' : 'H';
  if (t === 11) return canDouble ? 'D' : 'H';
  if (t === 12) return (up >= 4 && up <= 6) ? 'S' : 'H';
  if (t <= 16) return (up <= 6) ? 'S' : 'H';
  return 'S';
}

// ---------- the cage (persistent accounts) ----------
const accounts = new Map(); // token(secret) -> { name, cash, comps, no, pin }
const byNumber = new Map(); // player number -> token  (for logging back in)
let STORE = null; // set by initStore() — Postgres in prod, JSON file locally

function newPlayerNo() {
  for (;;) {
    const n = String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
    if (!byNumber.has(n)) return n;
  }
}
function newPin() { return String(Math.floor(1000 + Math.random() * 9000)); } // 4 digits
function pinEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length || !ba.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Persistent storage: Postgres in production (DATABASE_URL set — see
// store.js), a local JSON file otherwise. The in-memory `accounts` Map is a
// read cache in front of whichever backend; account mutations write through.
async function initStore() {
  STORE = store.create();
  const loaded = await STORE.init();
  for (const [token, acc] of loaded) accounts.set(token, acc);
  for (const [token, acc] of accounts) if (acc.no) byNumber.set(acc.no, token);
  // back-fill fields for accounts created before those features existed
  const toPersist = [];
  for (const [token, acc] of accounts) {
    let changed = false;
    if (!acc.no) { acc.no = newPlayerNo(); byNumber.set(acc.no, token); changed = true; }
    if (!acc.pin) { acc.pin = newPin(); changed = true; }
    if (typeof acc.compPoints !== 'number') { acc.compPoints = 0; changed = true; }
    if (changed) toPersist.push(token);
  }
  for (const token of toPersist) await persistAccount(token);
  // load staff admin logins
  try {
    for (const a of await STORE.getAdmins()) admins.set(a.username, { hash: a.hash, salt: a.salt });
  } catch (e) { console.error('[store] getAdmins failed:', e.message || e); }
  console.log('  Staff admins: ' + admins.size + (admins.size ? '' : ' (owner master key only until you add one)'));
}

// membership tier from lifetime comp points
function compTier(points) {
  points = points || 0;
  if (points >= 5000) return 'Platinum';
  if (points >= 1500) return 'Gold';
  if (points >= 400) return 'Silver';
  return 'Bronze';
}

// Fire-and-forget writers: they never throw, so callers may await them (for
// stronger durability before responding) or call them bare (background write).
async function persistAccount(token) {
  const acc = accounts.get(token);
  if (!acc) return;
  try { await STORE.upsertAccount(token, acc); }
  catch (e) { console.error('[store] upsertAccount failed:', e.message || e); }
}
async function recordTx(entry) {
  try { await STORE.logTransaction(entry); }
  catch (e) { console.error('[store] logTransaction failed:', e.message || e); }
}
async function recordHand(entry) {
  try { await STORE.logHand(entry); }
  catch (e) { console.error('[store] logHand failed:', e.message || e); }
}

function getAccount(token) {
  token = String(token || '').replace(/[^a-z0-9]/gi, '').slice(0, 40);
  let acc = token ? accounts.get(token) : null;
  let created = false, comped = false;
  if (!acc) {
    token = crypto.randomBytes(12).toString('hex');
    acc = { name: '', cash: START_CASH, comps: 0, compPoints: 0, since: new Date().toISOString(), no: newPlayerNo(), pin: newPin() };
    accounts.set(token, acc);
    byNumber.set(acc.no, token);
    created = true;
  } else if (acc.cash < 50) {
    acc.cash += COMP_CASH;
    acc.comps++;
    comped = true;
  }
  if (created || comped) {
    persistAccount(token);
    if (comped) recordTx({ token, type: 'comp', amount: COMP_CASH, balanceAfter: acc.cash, note: 'broke — cage comp' });
  }
  return { token, acc, created, comped };
}

// ---------- rooms ----------
const rooms = new Map();
const BOT_NAMES = ['Chad', 'Doris', 'Reno', 'Vinny', 'Lola', 'Ace', 'Mitzi', 'Duke', 'Sunny', 'Cash'];

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}

function sanitizeConfig(c) {
  c = c || {};
  const decks = [1, 2, 4, 6, 8].includes(+c.decks) ? +c.decks : 6;
  // table limits: min $1–$500, max min–$5,000, both multiples of $1
  let minBet = Math.round(Number(c.minBet));
  let maxBet = Math.round(Number(c.maxBet));
  if (!(minBet >= 1 && minBet <= 500)) minBet = 5;
  if (!(maxBet >= minBet && maxBet <= 5000)) maxBet = Math.max(minBet, 500);
  return {
    public: c.public !== false,
    decks: decks,
    payout: c.payout === '6:5' ? '6:5' : '3:2',
    h17: c.h17 !== false,     // dealer hits soft 17 (default true — most Vegas)
    das: c.das !== false,     // double after split allowed
    surrender: !!c.surrender, // late surrender
    minBet: minBet,
    maxBet: maxBet
  };
}

function rulesLine(cfg) {
  return [
    '$' + cfg.minBet + '–$' + cfg.maxBet,
    cfg.decks + ' decks',
    'blackjack pays ' + cfg.payout,
    'dealer ' + (cfg.h17 ? 'hits' : 'stands') + ' soft 17',
    cfg.das ? 'double after split' : 'no DAS',
    cfg.surrender ? 'surrender offered' : 'no surrender'
  ].join(' · ');
}

function freshGame(code, config) {
  const cfg = sanitizeConfig(config);
  return {
    code,
    config: cfg,
    decks: cfg.decks,
    shoe: buildShoe(cfg.decks),
    phase: 'betting',   // betting | insurance | acting | dealer | settle
    round: 0,
    dealer: [],
    holeHidden: true,
    players: [],
    hostId: null,
    turn: null,
    turnAt: 0,
    turnToken: 0,
    insuranceAt: 0,
    version: 1,
    lastActivity: Date.now(),
    log: [],
    conns: new Set(),
    pendingPush: false
  };
}

function bump(g) {
  g.version++;
  g.lastActivity = Date.now();
  pushSoon(g);
}

function log(g, line) {
  g.log.push(line);
  if (g.log.length > 40) g.log.shift();
  bump(g);
}

function freshPlayer(name, seat, token, buyIn) {
  return {
    id: Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
    name, seat, token,
    isBot: false, botStyle: null, leaveAfter: false,
    bankroll: buyIn, rebuys: 0,
    bet: 0, inRound: false,
    hands: [], activeHand: 0,
    insurance: null, insured: false,
    lastSeen: Date.now()
  };
}

function decks(g) { return g.config.decks; }
function bjMultiplier(g) { return g.config.payout === '6:5' ? 1.2 : 1.5; }
function bettors(g) { return g.players.filter(p => p.inRound).sort((a, b) => a.seat - b.seat); }
function playerById(g, id) { return g.players.find(p => p.id === id) || null; }
function humans(g) { return g.players.filter(p => !p.isBot); }
function draw(g) { return g.shoe.pop(); }
function dealerUpValue(g) { const c = g.dealer[0]; return c.r === 'A' ? 11 : c.v; }

function hasConn(g, playerId) {
  for (const c of g.conns) if (c.playerId === playerId && !c.dead) return true;
  return false;
}
function isPresent(g, p) {
  if (p.isBot) return true;
  return hasConn(g, p.id) || (Date.now() - p.lastSeen < PRESENCE_MS);
}

// the first human by seat is the host; reassigns if the host leaves
function ensureHost(g) {
  if (g.hostId && playerById(g, g.hostId) && !playerById(g, g.hostId).isBot) return;
  const h = humans(g).sort((a, b) => a.seat - b.seat)[0];
  const newId = h ? h.id : null;
  if (newId !== g.hostId) {
    g.hostId = newId;
    if (h) log(g, h.name + ' is now the table host.');
  }
}

function freeSeat(g) {
  const taken = g.players.map(q => q.seat);
  let seat = 1;
  while (taken.includes(seat)) seat++;
  return seat;
}

// color up: table chips go back to the player's cage account (humans only).
// Async (Postgres write) — await it where the response should reflect the
// confirmed balance; fire-and-forget is fine from background contexts
// (presence sweeps, mid-hand cash-outs) since errors are swallowed internally.
async function colorUp(g, p, reason) {
  let cash = null;
  if (!p.isBot) {
    const { token, acc } = getAccount(p.token);
    acc.cash += p.bankroll;
    cash = acc.cash;
    await persistAccount(token);
    await recordTx({ token, type: 'cashout', amount: p.bankroll, balanceAfter: acc.cash, tableCode: g.code, note: reason || null });
  }
  const chips = p.bankroll;
  g.players = g.players.filter(q => q.id !== p.id);
  log(g, p.name + ' colors up ' + fmt(chips) + ' and ' + (reason || 'heads to the cage.'));
  ensureHost(g);
  return cash;
}

// ---------- bots ----------
function addBot(g, style) {
  if (g.players.length >= MAX_SEATS) return 'Table is full.';
  const used = new Set(g.players.filter(p => p.isBot).map(p => p.name));
  const name = BOT_NAMES.find(n => !used.has(n)) || ('Bot' + (g.players.length + 1));
  const bot = freshPlayer(name, freeSeat(g), null, 1000);
  bot.isBot = true;
  bot.botStyle = style === 'gut' ? 'gut' : 'book';
  g.players.push(bot);
  log(g, name + ' (bot) takes a seat.');
  if (g.phase === 'betting') setBotBet(g, bot);
  return null;
}

function removeBot(g, botId) {
  const bot = playerById(g, botId);
  if (!bot || !bot.isBot) return 'No such bot.';
  if (bot.inRound && g.phase !== 'betting' && g.phase !== 'settle') return 'Wait for the hand to finish.';
  g.players = g.players.filter(p => p.id !== botId);
  log(g, bot.name + ' (bot) leaves the table.');
  return null;
}

function setBotBet(g, bot) {
  if (bot.bankroll < 50) bot.bankroll = 1000; // house keeps bots stocked
  const base = bot.botStyle === 'gut' ? 15 : 25;
  // bet the base, but never below the table minimum or above the max/bankroll
  let bet = Math.max(g.config.minBet, base);
  bet = Math.min(bet, g.config.maxBet, bot.bankroll);
  bot.bet = bet;
}

function placeBotBets(g) {
  for (const p of g.players) if (p.isBot) setBotBet(g, p);
}

// decide a bot action for the current hand
function botDecide(g, bot) {
  const h = bot.hands[bot.activeHand];
  const affordDouble = h.cards.length === 2 && bot.bankroll >= h.bet &&
    (!h.fromSplit || g.config.das);
  const affordSplit = h.cards.length === 2 && h.cards[0].v === h.cards[1].v &&
    bot.hands.length < 4 && bot.bankroll >= h.bet && !h.fromSplit;
  let move = basicStrategy(h.cards, dealerUpValue(g), affordDouble, affordSplit);
  if (move === 'D' && !affordDouble) move = 'H';
  if (move === 'P' && !affordSplit) move = basicStrategy(h.cards, dealerUpValue(g), affordDouble, false);
  // "gut" bots make tourist mistakes
  if (bot.botStyle === 'gut') {
    const hv = handValue(h.cards);
    if (move === 'D' && hv.soft) move = 'H';
    else if (move === 'D' && Math.random() < 0.4) move = 'H';
    else if (move === 'H' && !hv.soft && hv.total >= 12 && hv.total <= 16 &&
      dealerUpValue(g) >= 7 && Math.random() < 0.4) move = 'S';
  }
  return move;
}

function scheduleBot(g) {
  if (g.phase !== 'acting') return;
  const p = playerById(g, g.turn);
  if (!p || !p.isBot) return;
  const token = g.turnToken;
  setTimeout(() => botStep(g, p.id, token), BOT_MS);
}

function botStep(g, botId, token) {
  if (!rooms.has(g.code)) return;
  if (g.phase !== 'acting' || g.turn !== botId || g.turnToken !== token) return;
  const bot = playerById(g, botId);
  if (!bot || !bot.isBot) return;
  act(g, bot, botDecide(g, bot));
  // a plain hit keeps the turn — keep the bot going
  if (g.phase === 'acting' && g.turn === botId) scheduleBot(g);
}

// ---------- round flow ----------
function startRound(g, starter) {
  const lo = g.config.minBet;
  const bs = g.players.filter(p => p.bet >= lo && p.bet <= p.bankroll);
  if (!bs.length) return 'No bets on the felt yet.';
  if (g.shoe.length < decks(g) * 15 + 12) {
    g.shoe = buildShoe(decks(g));
    log(g, 'Dealer shuffles a fresh ' + decks(g) + '-deck shoe.');
  }
  g.round++;
  g.dealer = [];
  g.holeHidden = true;
  for (const p of g.players) {
    if (p.bet >= lo && p.bet <= p.bankroll) {
      p.inRound = true;
      p.bankroll -= p.bet;
      p.hands = [{ cards: [], bet: p.bet, done: false, busted: false,
        settled: false, result: null, resultCls: '', splitAces: false, fromSplit: false }];
      p.activeHand = 0;
      p.insurance = null;
      p.insured = false;
    } else {
      p.inRound = false;
      p.hands = [];
    }
  }
  const ordered = bettors(g);
  for (let pass = 0; pass < 2; pass++) {
    for (const p of ordered) p.hands[0].cards.push(draw(g));
    g.dealer.push(draw(g));
  }
  const up = dealerUpValue(g);
  log(g, starter.name + ' calls the deal. Dealer shows ' +
    (up === 11 ? 'an Ace' : 'a ' + up) + '.');
  if (up === 11) {
    g.phase = 'insurance';
    g.insuranceAt = Date.now();
    log(g, 'Insurance is open.');
    // bots decide insurance instantly (book declines; gut bots dabble)
    for (const p of bettors(g)) {
      if (!p.isBot) continue;
      const take = p.botStyle === 'gut' && Math.random() < 0.3 && p.bankroll >= p.bet / 2;
      if (take) { p.bankroll -= p.bet / 2; p.insured = true; p.insurance = 'yes'; }
      else p.insurance = 'no';
    }
    if (allInsuranceAnswered(g)) resolvePeek(g);
  } else {
    resolvePeek(g);
  }
  bump(g);
  return null;
}

function allInsuranceAnswered(g) {
  return bettors(g).every(p => p.insurance !== null);
}

function resolvePeek(g) {
  const up = dealerUpValue(g);
  const dBJ = isBlackjack(g.dealer);
  const mult = bjMultiplier(g);

  if ((up === 10 || up === 11) && dBJ) {
    g.holeHidden = false;
    for (const p of bettors(g)) {
      const h = p.hands[0];
      if (isBlackjack(h.cards)) {
        p.bankroll += h.bet;
        h.result = 'Push'; h.resultCls = 'push';
      } else {
        h.result = 'Lose'; h.resultCls = 'lose';
      }
      h.done = true; h.settled = true;
      if (p.insured) {
        p.bankroll += 1.5 * h.bet;
        log(g, p.name + "'s insurance bet pays 2 to 1.");
      }
    }
    g.phase = 'settle';
    g.turn = null;
    log(g, 'Dealer has blackjack.');
    finishSettle(g);
    return;
  }

  if (up === 11) log(g, 'No blackjack — insurance bets down.');

  for (const p of bettors(g)) {
    const h = p.hands[0];
    if (isBlackjack(h.cards)) {
      p.bankroll += h.bet * (1 + mult);
      h.result = 'Blackjack! +' + fmt(h.bet * mult); h.resultCls = 'win';
      h.done = true; h.settled = true;
      log(g, p.name + ' has blackjack! Paid ' + g.config.payout + '.');
    }
  }
  g.phase = 'acting';
  advance(g);
}

function advance(g) {
  for (const p of bettors(g)) {
    for (;;) {
      let idx = -1;
      for (let i = 0; i < p.hands.length; i++) {
        if (!p.hands[i].done) { idx = i; break; }
      }
      if (idx === -1) break;
      const h = p.hands[idx];
      if (h.cards.length === 1) {
        h.cards.push(draw(g));
        if (h.splitAces) { h.done = true; continue; }
        if (handValue(h.cards).total === 21) { h.done = true; continue; }
      }
      p.activeHand = idx;
      g.turn = p.id;
      g.turnAt = Date.now();
      g.turnToken++;
      bump(g);
      if (p.isBot) scheduleBot(g);
      return;
    }
  }
  g.turn = null;
  dealerPhase(g);
}

function anyLiveHands(g) {
  for (const p of bettors(g))
    for (const h of p.hands)
      if (!h.settled && handValue(h.cards).total <= 21) return true;
  return false;
}

function dealerPhase(g) {
  g.phase = 'dealer';
  g.holeHidden = false;
  const dv0 = handValue(g.dealer);
  log(g, 'Dealer turns over — ' + (dv0.soft && dv0.total < 21 ? 'soft ' : '') + dv0.total + '.');
  if (!anyLiveHands(g)) { settle(g, false); return; }
  const step = () => {
    if (g.phase !== 'dealer' || !rooms.has(g.code)) return;
    const hv = handValue(g.dealer);
    const mustHit = hv.total < 17 || (hv.total === 17 && hv.soft && g.config.h17);
    if (mustHit) {
      g.dealer.push(draw(g));
      bump(g);
      setTimeout(step, DEALER_MS);
    } else {
      settle(g, true);
    }
  };
  setTimeout(step, DEALER_MS);
}

function settle(g, anyLive) {
  const dv = handValue(g.dealer);
  for (const p of bettors(g)) {
    let delta = 0;
    for (const h of p.hands) {
      if (h.settled) continue;
      const pv = handValue(h.cards);
      if (dv.total > 21 || pv.total > dv.total) {
        p.bankroll += h.bet * 2;
        h.result = 'Win +' + fmt(h.bet); h.resultCls = 'win';
        delta += h.bet;
      } else if (pv.total < dv.total) {
        h.result = 'Lose'; h.resultCls = 'lose';
        delta -= h.bet;
      } else {
        p.bankroll += h.bet;
        h.result = 'Push'; h.resultCls = 'push';
      }
      h.settled = true;
    }
    if (p.hands.length && delta !== 0) {
      log(g, p.name + (delta > 0 ? ' wins ' : ' drops ') + fmt(Math.abs(delta)) + '.');
    }
  }
  g.phase = 'settle';
  if (anyLive) {
    log(g, dv.total > 21 ? 'Dealer busts with ' + dv.total + '!' : 'Dealer has ' + dv.total + '.');
  } else {
    log(g, 'Table busts — dealer takes it.');
  }
  finishSettle(g);
}

// how much a settled hand actually paid, for the history log
function handPayout(h) {
  const m = /\+\$([0-9.]+)/.exec(h.result || '');
  if (m) return Number(m[1]);
  if (h.result === 'Surrender') return -(h.bet / 2);
  if (h.resultCls === 'lose') return -h.bet;
  return 0; // push
}

// runs once per round, right after every hand is settled: logs game history
// for humans, awards comp points for what they wagered, and cashes out anyone
// who asked to leave mid-hand
function finishSettle(g) {
  for (const p of bettors(g)) {
    if (p.isBot) continue;
    let wagered = 0;
    for (const h of p.hands) {
      if (!h.settled) continue;
      wagered += h.bet;
      recordHand({ token: p.token, tableCode: g.code, round: g.round, bet: h.bet, result: h.result, payout: handPayout(h) });
    }
    if (wagered > 0) {
      const acc = accounts.get(p.token);
      if (acc) {
        acc.compPoints = (acc.compPoints || 0) + wagered; // 1 comp point per $1 wagered
        p.compPoints = acc.compPoints;
        persistAccount(p.token);
      }
    }
  }
  const leaving = g.players.filter(p => p.leaveAfter);
  for (const p of leaving) colorUp(g, p, 'cashes out.');
  bump(g);
}

function nextHand(g, p) {
  g.phase = 'betting';
  g.dealer = [];
  g.holeHidden = true;
  g.turn = null;
  for (const q of g.players) {
    q.hands = [];
    q.inRound = false;
    q.insurance = null;
    q.insured = false;
    if (q.bet > q.bankroll) q.bet = 0;
  }
  placeBotBets(g);
  log(g, (p ? p.name + ' calls for the next hand. ' : '') + 'Place your bets.');
}

// ---------- player actions ----------
function act(g, p, action) {
  if (g.phase !== 'acting') return 'Not the acting phase.';
  if (g.turn !== p.id) return 'Not your turn.';
  const h = p.hands[p.activeHand];
  const hv0 = handValue(h.cards);

  if (action === 'H') {
    h.cards.push(draw(g));
    const hv = handValue(h.cards);
    if (hv.total > 21) {
      h.busted = true; h.settled = true; h.done = true;
      h.result = 'Bust'; h.resultCls = 'lose';
      log(g, p.name + ' hits — ' + hv.total + '. Too many.');
      advance(g);
    } else if (hv.total === 21) {
      h.done = true;
      log(g, p.name + ' hits to twenty-one.');
      advance(g);
    } else {
      log(g, p.name + ' hits: ' + hv.total + '.');
      bump(g);
    }
    return null;
  }

  if (action === 'S') {
    h.done = true;
    log(g, p.name + ' stands on ' + (hv0.soft ? 'soft ' : '') + hv0.total + '.');
    advance(g);
    return null;
  }

  if (action === 'D') {
    if (h.cards.length !== 2 || h.splitAces) return 'Double only on your first two cards.';
    if (h.fromSplit && !g.config.das) return 'No double after split at this table.';
    if (p.bankroll < h.bet) return 'Not enough chips to double.';
    p.bankroll -= h.bet;
    h.bet *= 2;
    h.cards.push(draw(g));
    const hv = handValue(h.cards);
    if (hv.total > 21) {
      h.busted = true; h.settled = true;
      h.result = 'Bust'; h.resultCls = 'lose';
      log(g, p.name + ' doubles down — ' + hv.total + '. Too many.');
    } else {
      log(g, p.name + ' doubles down: ' + hv.total + '.');
    }
    h.done = true;
    advance(g);
    return null;
  }

  if (action === 'P') {
    const pair = h.cards.length === 2 && h.cards[0].v === h.cards[1].v;
    if (!pair || h.splitAces) return 'You can only split a fresh pair.';
    if (p.hands.length >= 4) return 'Table limit: four hands.';
    if (p.bankroll < h.bet) return 'Not enough chips to split.';
    p.bankroll -= h.bet;
    const c2 = h.cards.pop();
    const aces = h.cards[0].r === 'A';
    h.splitAces = aces;
    h.fromSplit = true;
    p.hands.splice(p.activeHand + 1, 0, {
      cards: [c2], bet: h.bet, done: false, busted: false,
      settled: false, result: null, resultCls: '', splitAces: aces, fromSplit: true
    });
    h.cards.push(draw(g));
    log(g, p.name + ' splits ' + (aces ? 'aces.' : 'the pair.'));
    if (aces) h.done = true;
    else if (handValue(h.cards).total === 21) h.done = true;
    if (h.done) advance(g); else bump(g);
    return null;
  }

  if (action === 'R') {
    if (!g.config.surrender) return 'Surrender is not offered here.';
    if (h.cards.length !== 2 || h.fromSplit || p.hands.length > 1) return 'Surrender only as your first decision.';
    p.bankroll += h.bet / 2;   // forfeit half
    h.result = 'Surrender'; h.resultCls = 'push';
    h.done = true; h.settled = true;
    log(g, p.name + ' surrenders — half back.');
    advance(g);
    return null;
  }

  return 'Unknown action.';
}

// ---------- watchdogs & presence (2s heartbeat) ----------
function watchdogs(g) {
  const now = Date.now();
  if (g.phase === 'acting' && g.turn && now - g.turnAt > TURN_TIMEOUT_MS) {
    const p = playerById(g, g.turn);
    if (p && !p.isBot) {
      log(g, p.name + ' is thinking too long — dealer waves it off (auto-stand).');
      p.hands[p.activeHand].done = true;
      advance(g);
    }
  }
  if (g.phase === 'insurance' && now - g.insuranceAt > INS_TIMEOUT_MS) {
    for (const p of bettors(g)) if (p.insurance === null) p.insurance = 'no';
    resolvePeek(g);
    bump(g);
  }
}

function presenceSweep(g) {
  const absent = g.players.filter(p => !isPresent(g, p));
  if (!absent.length) return;
  for (const p of absent) {
    if (p.inRound && (g.phase === 'acting' || g.phase === 'insurance' || g.phase === 'dealer')) {
      p.leaveAfter = true;   // banked when the hand settles
      if (g.phase === 'insurance' && p.insurance === null) {
        p.insurance = 'no';
        log(g, p.name + ' lost connection — no insurance.');
        if (allInsuranceAnswered(g)) { resolvePeek(g); bump(g); }
      }
      if (g.phase === 'acting' && g.turn === p.id) {
        log(g, p.name + ' lost connection — dealer stands the hand.');
        p.hands[p.activeHand].done = true;
        advance(g);
      }
    } else {
      colorUp(g, p, 'is gone — chips banked at the cage.');
    }
  }
}

setInterval(() => {
  for (const [code, g] of rooms) {
    watchdogs(g);
    presenceSweep(g);
    ensureHost(g);
    const anyHuman = humans(g).some(p => isPresent(g, p));
    if (!anyHuman && Date.now() - g.lastActivity > ROOM_IDLE_MS) rooms.delete(code);
  }
  if (rooms.size > MAX_ROOMS) {
    const byAge = [...rooms.entries()].sort((a, b) => a[1].lastActivity - b[1].lastActivity);
    while (rooms.size > MAX_ROOMS && byAge.length) rooms.delete(byAge.shift()[0]);
  }
}, 2000).unref();

// ---------- state snapshot ----------
function snapshot(g, youId) {
  const dealerCards = g.dealer.map((c, i) =>
    (i === 1 && g.holeHidden) ? { hidden: true } : c);
  const dv = handValue(g.dealer);
  const you = youId ? playerById(g, youId) : null;
  const snap = {
    version: g.version,
    room: g.code,
    phase: g.phase,
    round: g.round,
    shoe: g.shoe.length,
    host: g.hostId,
    config: g.config,
    rules: rulesLine(g.config),
    dealer: {
      cards: dealerCards,
      showing: g.dealer.length ? dealerUpValue(g) : null,
      total: (!g.holeHidden && g.dealer.length) ? dv.total : null,
      soft: (!g.holeHidden && g.dealer.length) ? dv.soft : false
    },
    turn: g.turn,
    players: g.players
      .slice()
      .sort((a, b) => a.seat - b.seat)
      .map(p => ({
        id: p.id, name: p.name, seat: p.seat,
        isBot: p.isBot, botStyle: p.botStyle,
        bankroll: p.bankroll, bet: p.bet, inRound: p.inRound,
        insurance: p.insurance,
        activeHand: p.activeHand,
        connected: isPresent(g, p),
        leaving: p.leaveAfter,
        hands: p.hands.map(h => ({
          cards: h.cards, bet: h.bet, done: h.done,
          result: h.result, resultCls: h.resultCls
        }))
      })),
    you: you ? youId : null,
    log: g.log.slice(-12)
  };
  if (you && !you.isBot) {
    const acc = accounts.get(you.token);
    if (acc) snap.cage = { cash: acc.cash, compPoints: acc.compPoints || 0, tier: compTier(acc.compPoints) };
  }
  return snap;
}

function lobbyList() {
  return [...rooms.values()]
    .filter(g => g.config.public)
    .map(g => ({
      code: g.code,
      host: (playerById(g, g.hostId) || {}).name || '—',
      humans: humans(g).length,
      bots: g.players.filter(p => p.isBot).length,
      seats: g.players.length,
      phase: g.phase,
      payout: g.config.payout,
      rules: rulesLine(g.config)
    }))
    .sort((a, b) => b.humans - a.humans);
}

// ---------- websocket plumbing (hand-rolled RFC 6455, text frames) ----------
function wsFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function wsSend(conn, str) {
  if (conn.dead) return;
  try { conn.socket.write(wsFrame(0x1, Buffer.from(str))); }
  catch (e) { killConn(conn); }
}

function killConn(conn) {
  if (conn.dead) return;
  conn.dead = true;
  try { conn.socket.destroy(); } catch (e) {}
  const g = rooms.get(conn.room);
  if (g) g.conns.delete(conn);
}

function pushSoon(g) {
  if (g.pendingPush) return;
  g.pendingPush = true;
  setImmediate(() => {
    g.pendingPush = false;
    for (const conn of g.conns) {
      if (!conn.dead) wsSend(conn, JSON.stringify(snapshot(g, conn.playerId)));
    }
  });
}

function handleWsData(conn, data) {
  conn.buffer = Buffer.concat([conn.buffer, data]);
  for (;;) {
    const buf = conn.buffer;
    if (buf.length < 2) return;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) return;
      len = buf.readUInt16BE(2); off = 4;
    } else if (len === 127) {
      if (buf.length < 10) return;
      len = Number(buf.readBigUInt64BE(2)); off = 10;
    }
    if (len > 65536) { killConn(conn); return; }
    let mask = null;
    if (masked) {
      if (buf.length < off + 4) return;
      mask = buf.subarray(off, off + 4); off += 4;
    }
    if (buf.length < off + len) return;
    const payload = Buffer.from(buf.subarray(off, off + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    conn.buffer = buf.subarray(off + len);

    if (opcode === 0x8) {
      try { conn.socket.write(wsFrame(0x8, Buffer.alloc(0))); } catch (e) {}
      killConn(conn);
      return;
    }
    if (opcode === 0x9) { try { conn.socket.write(wsFrame(0xA, payload)); } catch (e) {} continue; }
    if (opcode === 0xA) {
      conn.lastPong = Date.now();
      const g = rooms.get(conn.room);
      if (g) { const p = playerById(g, conn.playerId); if (p) p.lastSeen = Date.now(); }
      continue;
    }
  }
}

setInterval(() => {
  for (const g of rooms.values()) {
    for (const conn of g.conns) {
      if (conn.dead) continue;
      if (Date.now() - conn.lastPong > 70000) { killConn(conn); continue; }
      try { conn.socket.write(wsFrame(0x9, Buffer.alloc(0))); } catch (e) { killConn(conn); }
    }
  }
}, 25000).unref();

// ---------- rate limiting (per-IP token buckets, no dependency) ----------
// GET /api/state is exempt (cheap read; the websocket carries live play, this
// is just the polling fallback). Every POST /api/* is bucketed by tier.
const rateBuckets = new Map(); // "tier:ip" -> { count, resetAt }
function rateRule(pathname) {
  // Only the credential-guessing surfaces get the strict limit. Everything
  // else under /api/admin/* is already gated by a session or the owner key,
  // so it uses the generous gameplay tier — otherwise the admin console's own
  // 5-second auto-refresh would trip the limit.
  if (pathname === '/api/login' || pathname === '/api/admin/login')
    return { tier: 'strict', max: RATE_LOGIN_MAX };
  if (pathname === '/api/join' || pathname === '/api/account')
    return { tier: 'moderate', max: RATE_JOIN_MAX };
  return { tier: 'gameplay', max: RATE_GAMEPLAY_MAX };
}
function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
// returns seconds-until-reset if the caller should be rejected, else null
function checkRateLimit(req, pathname) {
  const rule = rateRule(pathname);
  const key = rule.tier + ':' + clientIp(req);
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + RATE_WINDOW_MS }; rateBuckets.set(key, b); }
  b.count++;
  return b.count > rule.max ? Math.max(1, Math.ceil((b.resetAt - now) / 1000)) : null;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of rateBuckets) if (now > b.resetAt) rateBuckets.delete(k);
}, 60000).unref();

// ---------- http plumbing ----------
function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 10000) { reject(new Error('too big')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

function lanUrls() {
  const urls = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const inf of ifaces[name] || []) {
      if (inf.family === 'IPv4' && !inf.internal) urls.push('http://' + inf.address + ':' + PORT);
    }
  }
  return urls;
}

function normalizeRoom(code) {
  code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return (code.length >= 3 && code.length <= 8) ? code : '';
}

function cleanName(s) {
  return String(s || '').replace(/[^A-Za-z0-9 _.'-]/g, '').trim().slice(0, 14);
}

const STATIC_FILES = {
  '/': 'landing.html',
  '/index.html': 'landing.html',
  '/play': 'table.html',
  '/play.html': 'table.html',
  '/table.html': 'table.html',
  '/vegas-playbook.html': 'vegas-playbook.html',
  '/blackjack-trainer.html': 'blackjack-trainer.html',
  '/admin': 'admin.html',
  '/admin.html': 'admin.html',
  '/privacy.html': 'privacy.html',
  '/terms.html': 'terms.html',
  '/donate': 'donate.html',
  '/donate.html': 'donate.html'
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  try {
    if (p === '/api/state' && req.method === 'GET') {
      const code = normalizeRoom(url.searchParams.get('t'));
      const g = code ? rooms.get(code) : null;
      if (!g) { sendJSON(res, 200, { noRoom: true, version: 0 }); return; }
      const youId = url.searchParams.get('playerId') || null;
      const you = youId ? playerById(g, youId) : null;
      if (you) you.lastSeen = Date.now();
      const v = parseInt(url.searchParams.get('v') || '0', 10);
      if (v === g.version) { sendJSON(res, 200, { version: g.version, unchanged: true }); return; }
      sendJSON(res, 200, snapshot(g, youId));
      return;
    }
    if (p === '/api/lobby' && req.method === 'GET') {
      sendJSON(res, 200, { tables: lobbyList() });
      return;
    }
    if (p === '/api/info' && req.method === 'GET') {
      sendJSON(res, 200, { name: 'TABLE SEVEN', port: PORT, urls: lanUrls() });
      return;
    }
    if (req.method === 'POST' && p.startsWith('/api/')) {
      const retryAfter = checkRateLimit(req, p);
      if (retryAfter !== null) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter), 'X-Content-Type-Options': 'nosniff' });
        res.end(JSON.stringify({ error: 'Too many requests — slow down and try again in a bit.' }));
        return;
      }
      const body = await readBody(req);

      // ----- admin login: owner master key OR a staff username+password -----
      if (p === '/api/admin/login') {
        const username = String(body.username || '').trim();
        if (username) {
          const rec = admins.get(username);
          if (rec && verifyPassword(body.password, rec)) {
            sendJSON(res, 200, { session: newSession(username, false), who: username, isOwner: false });
            return;
          }
          await new Promise(r => setTimeout(r, 400));
          sendJSON(res, 403, { error: 'Wrong username or password.' });
          return;
        }
        if (isMasterKey(body.key)) {
          sendJSON(res, 200, { session: newSession('owner', true), who: 'owner', isOwner: true });
          return;
        }
        await new Promise(r => setTimeout(r, 400));
        sendJSON(res, 403, { error: 'Wrong owner key.' });
        return;
      }

      if (p.startsWith('/api/admin/')) {
        const auth = adminAuth(body);
        if (!auth) {
          await new Promise(r => setTimeout(r, 300));
          sendJSON(res, 403, { error: 'Not signed in as an admin.' });
          return;
        }

        // ----- staff management (owner only) -----
        if (p === '/api/admin/staff') {
          if (!auth.isOwner) { sendJSON(res, 403, { error: 'Only the owner can manage staff.' }); return; }
          sendJSON(res, 200, { admins: [...admins.keys()].sort(), you: auth.who, isOwner: auth.isOwner });
          return;
        }
        if (p === '/api/admin/add-staff') {
          if (!auth.isOwner) { sendJSON(res, 403, { error: 'Only the owner can add staff.' }); return; }
          const username = String(body.username || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 24);
          const password = String(body.password || '');
          if (username.length < 3) { sendJSON(res, 400, { error: 'Username needs 3+ letters/numbers.' }); return; }
          if (password.length < 6) { sendJSON(res, 400, { error: 'Password needs 6+ characters.' }); return; }
          if (username === 'owner') { sendJSON(res, 400, { error: '"owner" is reserved.' }); return; }
          const rec = hashPassword(password);
          admins.set(username, rec);
          try { await STORE.upsertAdmin(username, rec); } catch (e) { console.error('[store] upsertAdmin failed:', e.message || e); }
          sendJSON(res, 200, { ok: true });
          return;
        }
        if (p === '/api/admin/remove-staff') {
          if (!auth.isOwner) { sendJSON(res, 403, { error: 'Only the owner can remove staff.' }); return; }
          const username = String(body.username || '');
          if (!admins.has(username)) { sendJSON(res, 400, { error: 'No such staff admin.' }); return; }
          admins.delete(username);
          for (const [t, s] of adminSessions) if (s.who === username) adminSessions.delete(t);
          try { await STORE.deleteAdmin(username); } catch (e) { console.error('[store] deleteAdmin failed:', e.message || e); }
          sendJSON(res, 200, { ok: true });
          return;
        }

        if (p === '/api/admin/overview') {
          const seatedAt = {};
          for (const g of rooms.values())
            for (const q of g.players) if (q.token) seatedAt[q.token] = g.code;
          const accs = [...accounts.entries()].map(([token, acc]) => ({
            token, no: acc.no || '—', name: acc.name || '(unnamed)', cash: acc.cash,
            comps: acc.comps || 0, compPoints: acc.compPoints || 0, tier: compTier(acc.compPoints),
            since: acc.since || null, seated: seatedAt[token] || null
          })).sort((x, y) => y.cash - x.cash);
          const tables = [...rooms.values()].map(g => ({
            code: g.code, phase: g.phase, round: g.round,
            public: g.config.public, payout: g.config.payout, rules: rulesLine(g.config),
            players: g.players.map(q => ({
              name: q.name + (q.isBot ? ' 🤖' : ''), chips: q.bankroll, connected: isPresent(g, q)
            }))
          }));
          sendJSON(res, 200, { accounts: accs, tables, you: auth.who, isOwner: auth.isOwner });
          return;
        }
        if (p === '/api/admin/delete') {
          const token = String(body.token || '');
          const acc0 = accounts.get(token);
          if (!acc0) { sendJSON(res, 400, { error: 'No such account.' }); return; }
          for (const g of rooms.values()) {
            const q = g.players.find(pp => pp.token === token);
            if (q) { g.players = g.players.filter(pp => pp.id !== q.id); ensureHost(g); bump(g); }
          }
          await recordTx({ token, type: 'account_deleted', amount: 0, balanceAfter: acc0.cash, note: 'deleted by pit boss' });
          if (acc0.no) byNumber.delete(acc0.no);
          accounts.delete(token);
          try { await STORE.deleteAccount(token); } catch (e) { console.error('[store] deleteAccount failed:', e.message || e); }
          sendJSON(res, 200, { ok: true });
          return;
        }
        if (p === '/api/admin/resetpin') {
          const token = String(body.token || '');
          const acc = accounts.get(token);
          if (!acc) { sendJSON(res, 400, { error: 'No such account.' }); return; }
          acc.pin = newPin();
          await persistAccount(token);
          sendJSON(res, 200, { ok: true, no: acc.no, pin: acc.pin });
          return;
        }
        if (p === '/api/admin/history') {
          const token = String(body.token || '');
          if (!accounts.has(token)) { sendJSON(res, 400, { error: 'No such account.' }); return; }
          const hist = await STORE.getHistory(token, 100);
          sendJSON(res, 200, hist);
          return;
        }
        if (p !== '/api/admin/credit') { sendJSON(res, 404, { error: 'No such admin endpoint.' }); return; }
        const token = String(body.token || '');
        const acc = accounts.get(token);
        if (!acc) { sendJSON(res, 400, { error: 'No such account.' }); return; }
        const amount = Math.round(Number(body.amount) || 0);
        if (!amount || Math.abs(amount) > 100000) {
          sendJSON(res, 400, { error: 'Amount must be between −$100,000 and $100,000 (not zero).' });
          return;
        }
        acc.cash = Math.max(0, acc.cash + amount);
        await persistAccount(token);
        await recordTx({ token, type: amount > 0 ? 'admin_credit' : 'admin_dock', amount, balanceAfter: acc.cash, note: 'pit boss adjustment' });
        for (const g of rooms.values()) {
          const q = g.players.find(pp => pp.token === body.token);
          if (q) log(g, amount > 0
            ? 'The pit boss credits ' + q.name + '’s cage account ' + fmt(amount) + '.'
            : 'The pit boss docks ' + q.name + '’s cage account ' + fmt(-amount) + '.');
        }
        sendJSON(res, 200, { ok: true, cash: acc.cash });
        return;
      }

      if (p === '/api/account') {
        const { token, acc, created, comped } = getAccount(body.token);
        if (body.name) { acc.name = cleanName(body.name); persistAccount(token); }
        sendJSON(res, 200, { token, cash: acc.cash, name: acc.name, no: acc.no, pin: acc.pin,
          compPoints: acc.compPoints || 0, tier: compTier(acc.compPoints), since: acc.since || null, created, comped });
        return;
      }

      if (p === '/api/login') {
        const number = String(body.number || '').replace(/\D/g, '').slice(0, 8);
        const pin = String(body.pin || '').replace(/\D/g, '').slice(0, 8);
        const token = byNumber.get(number);
        const acc = token ? accounts.get(token) : null;
        if (!acc || !pinEqual(acc.pin, pin)) {
          await new Promise(r => setTimeout(r, 400)); // slow brute force
          sendJSON(res, 403, { error: 'Player number or PIN is wrong.' });
          return;
        }
        // tidy up: if they were a brand-new untouched guest, retire that account
        const discard = String(body.discard || '');
        if (discard && discard !== token && accounts.has(discard)) {
          const guest = accounts.get(discard);
          const seated = [...rooms.values()].some(r => r.players.some(pp => pp.token === discard));
          if (guest.cash === START_CASH && !guest.name && !seated) {
            accounts.delete(discard); byNumber.delete(guest.no);
            try { await STORE.deleteAccount(discard); } catch (e) { console.error('[store] deleteAccount failed:', e.message || e); }
          }
        }
        sendJSON(res, 200, { token, cash: acc.cash, name: acc.name, no: acc.no, pin: acc.pin,
          compPoints: acc.compPoints || 0, tier: compTier(acc.compPoints), since: acc.since || null });
        return;
      }

      if (p === '/api/join') {
        const name = cleanName(body.name);
        if (!name) { sendJSON(res, 400, { error: 'Need a name (letters and numbers).' }); return; }
        const { token, acc } = getAccount(body.token);
        const buyIn = Math.floor(Number(body.buyIn) || 0);
        if (buyIn < 50 || buyIn > 2000) { sendJSON(res, 400, { error: 'Buy in for $50 to $2,000.' }); return; }
        if (buyIn > acc.cash) { sendJSON(res, 400, { error: 'The cage says you only have ' + fmt(acc.cash) + '.' }); return; }
        let code = normalizeRoom(body.room);
        let g = code ? rooms.get(code) : null;
        const creating = !g;
        if (!g) {
          if (rooms.size >= MAX_ROOMS) { sendJSON(res, 503, { error: 'Too many tables open — try again soon.' }); return; }
          if (!code) code = newCode();
          g = freshGame(code, body.config);
          rooms.set(code, g);
        }
        if (g.players.length >= MAX_SEATS) { sendJSON(res, 400, { error: 'That table is full.' }); return; }
        // one seat per account at a table
        if (g.players.some(q => q.token === token)) { sendJSON(res, 400, { error: 'You are already seated here.' }); return; }
        acc.name = name;
        acc.cash -= buyIn;
        await persistAccount(token);
        await recordTx({ token, type: 'buyin', amount: -buyIn, balanceAfter: acc.cash, tableCode: code });
        const np = freshPlayer(name, freeSeat(g), token, buyIn);
        g.players.push(np);
        ensureHost(g);
        log(g, name + ' buys in for ' + fmt(buyIn) + ' — seat ' + np.seat + '.');
        if (g.phase === 'betting') { /* bots already have bets */ }
        sendJSON(res, 200, {
          playerId: np.id, seat: np.seat, room: code, token, cash: acc.cash,
          host: g.hostId === np.id, created: creating
        });
        return;
      }

      const g = rooms.get(normalizeRoom(body.room));
      if (!g) { sendJSON(res, 400, { error: 'That table has closed — join again.' }); return; }
      const player = body.playerId ? playerById(g, body.playerId) : null;
      if (!player) { sendJSON(res, 400, { error: 'Unknown player — join first.' }); return; }
      player.lastSeen = Date.now();
      const isHost = g.hostId === player.id;

      if (p === '/api/bet') {
        if (g.phase !== 'betting') { sendJSON(res, 409, { error: 'Betting is closed.' }); return; }
        const amt = Math.floor(Number(body.amount) || 0);
        const lo = g.config.minBet, hi = g.config.maxBet;
        if (amt !== 0 && (amt < lo || amt > hi)) { sendJSON(res, 400, { error: 'This table takes $' + lo + ' to $' + hi + ' (or 0 to sit out).' }); return; }
        if (amt > player.bankroll) { sendJSON(res, 400, { error: 'That is more than your chips.' }); return; }
        player.bet = amt;
        bump(g);
        sendJSON(res, 200, { ok: true });
        return;
      }
      if (p === '/api/deal') {
        if (g.phase !== 'betting') { sendJSON(res, 409, { error: 'A round is already going.' }); return; }
        const err = startRound(g, player);
        if (err) { sendJSON(res, 400, { error: err }); return; }
        sendJSON(res, 200, { ok: true });
        return;
      }
      if (p === '/api/insurance') {
        if (g.phase !== 'insurance') { sendJSON(res, 409, { error: 'Insurance is not open.' }); return; }
        if (!player.inRound || player.insurance !== null) { sendJSON(res, 409, { error: 'Already answered.' }); return; }
        if (body.take && player.bankroll >= player.bet / 2) {
          player.bankroll -= player.bet / 2;
          player.insured = true;
          player.insurance = 'yes';
          log(g, player.name + ' takes insurance.');
        } else {
          player.insurance = 'no';
          log(g, player.name + ' waves off insurance.');
        }
        if (allInsuranceAnswered(g)) resolvePeek(g);
        bump(g);
        sendJSON(res, 200, { ok: true });
        return;
      }
      if (p === '/api/action') {
        const err = act(g, player, String(body.act || ''));
        if (err) { sendJSON(res, 409, { error: err }); return; }
        sendJSON(res, 200, { ok: true });
        return;
      }
      if (p === '/api/next') {
        if (g.phase !== 'settle') { sendJSON(res, 409, { error: 'The hand is still going.' }); return; }
        nextHand(g, player);
        bump(g);
        sendJSON(res, 200, { ok: true });
        return;
      }
      if (p === '/api/rebuy') {
        if (g.phase !== 'betting') { sendJSON(res, 409, { error: 'Wait for the betting phase.' }); return; }
        const { token, acc } = getAccount(player.token);
        const amount = Math.min(300, acc.cash);
        if (amount < 5) { sendJSON(res, 400, { error: 'The cage says your account is empty. It restakes you when you rejoin.' }); return; }
        acc.cash -= amount;
        await persistAccount(token);
        await recordTx({ token, type: 'rebuy', amount: -amount, balanceAfter: acc.cash, tableCode: g.code });
        player.bankroll += amount;
        player.rebuys++;
        log(g, player.name + ' rebuys ' + fmt(amount) + ' from the cage.');
        sendJSON(res, 200, { ok: true, cash: acc.cash });
        return;
      }
      if (p === '/api/leave') {
        const { acc } = getAccount(player.token);
        if (player.inRound && (g.phase === 'acting' || g.phase === 'insurance' || g.phase === 'dealer')) {
          player.leaveAfter = true;
          if (g.phase === 'insurance' && player.insurance === null) {
            player.insurance = 'no';
            if (allInsuranceAnswered(g)) resolvePeek(g);
          }
          if (g.phase === 'acting' && g.turn === player.id) {
            player.hands[player.activeHand].done = true;
            advance(g);
          }
          for (const conn of g.conns) if (conn.playerId === player.id) killConn(conn);
          bump(g);
          sendJSON(res, 200, { ok: true, pending: true, cash: acc.cash });
          return;
        }
        const cash = await colorUp(g, player, 'heads to the cage.');
        for (const conn of g.conns) if (conn.playerId === player.id) killConn(conn);
        bump(g);
        sendJSON(res, 200, { ok: true, cash });
        return;
      }

      // ----- host controls -----
      if (p === '/api/room/config') {
        if (!isHost) { sendJSON(res, 403, { error: 'Only the host can change the rules.' }); return; }
        if (g.phase !== 'betting') { sendJSON(res, 409, { error: 'Change rules between hands.' }); return; }
        const prevDecks = g.config.decks;
        g.config = sanitizeConfig(Object.assign({}, g.config, body.config));
        if (g.config.decks !== prevDecks) g.shoe = buildShoe(g.config.decks);
        log(g, player.name + ' sets the house rules: ' + rulesLine(g.config) + '.');
        bump(g);
        sendJSON(res, 200, { ok: true });
        return;
      }
      if (p === '/api/room/addbot') {
        if (!isHost) { sendJSON(res, 403, { error: 'Only the host can add bots.' }); return; }
        const err = addBot(g, body.style);
        if (err) { sendJSON(res, 400, { error: err }); return; }
        bump(g);
        sendJSON(res, 200, { ok: true });
        return;
      }
      if (p === '/api/room/removebot') {
        if (!isHost) { sendJSON(res, 403, { error: 'Only the host can remove bots.' }); return; }
        const err = removeBot(g, body.botId);
        if (err) { sendJSON(res, 400, { error: err }); return; }
        bump(g);
        sendJSON(res, 200, { ok: true });
        return;
      }

      sendJSON(res, 404, { error: 'No such endpoint.' });
      return;
    }

    const file = STATIC_FILES[p];
    if (!file) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    fs.readFile(path.join(ROOT, file), (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  } catch (e) {
    sendJSON(res, 400, { error: e.message || 'Bad request' });
  }
});

// websocket upgrade: /ws?t=ROOM&playerId=ID
server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);

  const code = normalizeRoom(url.searchParams.get('t'));
  const playerId = url.searchParams.get('playerId') || '';
  const g = code ? rooms.get(code) : null;
  const conn = { socket, room: code, playerId, buffer: Buffer.alloc(0), dead: false, lastPong: Date.now() };
  if (!g || !playerById(g, playerId)) {
    try { socket.write(wsFrame(0x1, Buffer.from(JSON.stringify({ noRoom: true, version: 0 })))); } catch (e) {}
    setTimeout(() => { try { socket.destroy(); } catch (e) {} }, 100);
    return;
  }
  g.conns.add(conn);
  playerById(g, playerId).lastSeen = Date.now();
  socket.on('data', d => handleWsData(conn, d));
  socket.on('close', () => killConn(conn));
  socket.on('error', () => killConn(conn));
  socket.on('end', () => killConn(conn));
  wsSend(conn, JSON.stringify(snapshot(g, playerId)));
});

initStore().then(() => {
  server.listen(PORT, () => {
    console.log('');
    console.log('  ♠ ♥  T A B L E   S E V E N  ♦ ♣');
    console.log('  The casino is open on port ' + PORT + '  (live websockets + cage + bots)');
    console.log('');
    console.log('  Play here:            http://localhost:' + PORT);
    for (const u of lanUrls()) console.log('  Same-WiFi players:    ' + u);
    console.log('');
    console.log('  Storage:              ' + (process.env.DATABASE_URL ? 'Postgres (persists across redeploys)' : 'local JSON file (cage-data.json — set DATABASE_URL in production)'));
    console.log('  Every visitor gets a $' + START_CASH + ' cage account.');
    console.log('  First to sit hosts the table: add bots + set the rules.');
    console.log('');
    console.log('  Pit Boss console:     http://localhost:' + PORT + '/admin');
    console.log('  Pit Boss key:         ' + ADMIN_KEY +
      (process.env.TABLE_ADMIN_KEY ? '  (from TABLE_ADMIN_KEY)' : '  (random this boot — set TABLE_ADMIN_KEY to fix it)'));
    console.log('  Press Ctrl+C to close the casino.');
    console.log('');
  });
}).catch(e => {
  console.error('Failed to initialize storage:', e);
  process.exit(1);
});
