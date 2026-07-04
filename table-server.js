// TABLE SEVEN — private multiplayer blackjack casino with a strategy coach.
// Zero dependencies: plain Node.js (>=18). Run locally with:
//   node table-server.js            (or double-click Start-TableSeven.cmd)
// Deploys anywhere that runs Node (Railway, etc.) — it honors process.env.PORT.
//
// The casino:
//   - THE CAGE: every visitor gets a persistent account (cage-data.json).
//     New players are staked $1,000. You buy chips into a table and color up
//     back to cash when you leave — winnings survive between sessions.
//   - TABLES: private rooms with 4-char codes, share links like /?t=K7Q4.
//   - WEBSOCKETS: hand-rolled RFC-6455 server (no npm packages). State is
//     pushed instantly, and when someone closes their tab the table notices
//     within seconds, banks their chips at the cage, and frees the seat.
//
// Rules: 6 decks, blackjack pays 3:2, dealer hits soft 17, double after split,
// split up to 4 hands, split aces get one card, insurance on a dealer ace.

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT || 7777;
const FAST = !!process.env.TABLE_FAST;          // used by automated tests
const DEALER_MS = FAST ? 0 : 800;               // dealer draw cadence
const TURN_TIMEOUT_MS = FAST ? 3600000 : 45000; // auto-stand a present-but-idle player
const INS_TIMEOUT_MS = FAST ? 3600000 : 30000;
const PRESENCE_MS = Number(process.env.TABLE_PRESENCE_MS) || (FAST ? 3600000 : 12000);
const ROOM_IDLE_MS = FAST ? 3600000 : 20 * 60000;
const MAX_ROOMS = 50;
const START_CASH = 1000;   // the cage stakes every new player
const COMP_CASH = 500;     // pity stake when you go broke
const ROOT = __dirname;

// Pit Boss key: set TABLE_ADMIN_KEY for a stable key (e.g. on Railway);
// otherwise a fresh one is generated and printed at boot.
const ADMIN_KEY = process.env.TABLE_ADMIN_KEY || require('crypto').randomBytes(6).toString('hex');

function isAdmin(key) {
  const a = crypto.createHash('sha256').update(String(key || '')).digest();
  const b = crypto.createHash('sha256').update(ADMIN_KEY).digest();
  return crypto.timingSafeEqual(a, b);
}

// ---------- blackjack engine (same rules as the trainer) ----------
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

// ---------- the cage (persistent accounts) ----------
const CAGE_FILE = process.env.TABLE_CAGE_FILE || path.join(ROOT, 'cage-data.json');
const accounts = new Map(); // token -> { name, cash, comps }
let cageSaveTimer = null;

function loadCage() {
  try {
    const data = JSON.parse(fs.readFileSync(CAGE_FILE, 'utf8'));
    for (const [token, acc] of Object.entries(data)) accounts.set(token, acc);
    console.log('  Cage ledger loaded: ' + accounts.size + ' account(s).');
  } catch (e) { /* first run — empty cage */ }
}

function saveCageSoon() {
  if (cageSaveTimer) return;
  cageSaveTimer = setTimeout(() => {
    cageSaveTimer = null;
    const data = {};
    for (const [token, acc] of accounts) data[token] = acc;
    fs.writeFile(CAGE_FILE, JSON.stringify(data, null, 1), () => {});
  }, 800);
}

function getAccount(token) {
  token = String(token || '').replace(/[^a-z0-9]/gi, '').slice(0, 40);
  let acc = token ? accounts.get(token) : null;
  let created = false, comped = false;
  if (!acc) {
    token = crypto.randomBytes(12).toString('hex');
    acc = { name: '', cash: START_CASH, comps: 0 };
    accounts.set(token, acc);
    created = true;
  } else if (acc.cash < 50) {
    acc.cash += COMP_CASH;
    acc.comps++;
    comped = true;
  }
  saveCageSoon();
  return { token, acc, created, comped };
}

// ---------- rooms ----------
const rooms = new Map();

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}

function freshGame(code) {
  return {
    code,
    shoe: buildShoe(6),
    phase: 'betting',   // betting | insurance | acting | dealer | settle
    round: 0,
    dealer: [],
    holeHidden: true,
    players: [],
    turn: null,
    turnAt: 0,
    insuranceAt: 0,
    version: 1,
    lastActivity: Date.now(),
    log: [],
    conns: new Set(),   // live websocket connections
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
    bankroll: buyIn, rebuys: 0,
    bet: 0, inRound: false,
    hands: [], activeHand: 0,
    insurance: null, insured: false,
    lastSeen: Date.now()
  };
}

function bettors(g) {
  return g.players.filter(p => p.inRound).sort((a, b) => a.seat - b.seat);
}

function playerById(g, id) {
  return g.players.find(p => p.id === id) || null;
}

function draw(g) { return g.shoe.pop(); }

function dealerUpValue(g) {
  const c = g.dealer[0];
  return c.r === 'A' ? 11 : c.v;
}

function hasConn(g, playerId) {
  for (const c of g.conns) if (c.playerId === playerId && !c.dead) return true;
  return false;
}

function isPresent(g, p) {
  return hasConn(g, p.id) || (Date.now() - p.lastSeen < PRESENCE_MS);
}

// color up: table chips go back to the player's cage account
function colorUp(g, p, reason) {
  const { acc } = getAccount(p.token);
  acc.cash += p.bankroll;
  saveCageSoon();
  const chips = p.bankroll;
  g.players = g.players.filter(q => q.id !== p.id);
  log(g, p.name + ' colors up ' + fmt(chips) + ' and ' + (reason || 'heads to the cage.'));
  return acc.cash;
}

// ---------- round flow ----------
function startRound(g, starter) {
  const bs = g.players.filter(p => p.bet >= 5 && p.bet <= p.bankroll);
  if (!bs.length) return 'No bets on the felt yet.';
  if (g.shoe.length < 120) {
    g.shoe = buildShoe(6);
    log(g, 'Dealer shuffles a fresh six-deck shoe.');
  }
  g.round++;
  g.dealer = [];
  g.holeHidden = true;
  for (const p of g.players) {
    if (p.bet >= 5 && p.bet <= p.bankroll) {
      p.inRound = true;
      p.bankroll -= p.bet;
      p.hands = [{ cards: [], bet: p.bet, done: false, busted: false,
        settled: false, result: null, resultCls: '', splitAces: false }];
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
    return;
  }

  if (up === 11) log(g, 'No blackjack — insurance bets down.');

  for (const p of bettors(g)) {
    const h = p.hands[0];
    if (isBlackjack(h.cards)) {
      p.bankroll += h.bet * 2.5;
      h.result = 'Blackjack! +' + fmt(h.bet * 1.5); h.resultCls = 'win';
      h.done = true; h.settled = true;
      log(g, p.name + ' has blackjack! Paid 3:2.');
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
      bump(g);
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
    if (hv.total < 17 || (hv.total === 17 && hv.soft)) {
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
  log(g, p.name + ' calls for the next hand. Place your bets.');
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
    p.hands.splice(p.activeHand + 1, 0, {
      cards: [c2], bet: h.bet, done: false, busted: false,
      settled: false, result: null, resultCls: '', splitAces: aces
    });
    h.cards.push(draw(g));
    log(g, p.name + ' splits ' + (aces ? 'aces.' : 'the pair.'));
    if (aces) h.done = true;
    else if (handValue(h.cards).total === 21) h.done = true;
    if (h.done) advance(g); else bump(g);
    return null;
  }

  return 'Unknown action.';
}

// ---------- watchdogs & presence (driven by a 2s heartbeat) ----------
function watchdogs(g) {
  const now = Date.now();
  if (g.phase === 'acting' && g.turn && now - g.turnAt > TURN_TIMEOUT_MS) {
    const p = playerById(g, g.turn);
    if (p) {
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
      // finish their obligations, remove them when the hand ends
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
    const anyoneHere = g.players.some(p => isPresent(g, p));
    if (!anyoneHere && Date.now() - g.lastActivity > ROOM_IDLE_MS) rooms.delete(code);
  }
  if (rooms.size > MAX_ROOMS) {
    // oldest inactive rooms go first
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
        bankroll: p.bankroll, bet: p.bet, inRound: p.inRound,
        insurance: p.insurance,
        activeHand: p.activeHand,
        connected: isPresent(g, p),
        hands: p.hands.map(h => ({
          cards: h.cards, bet: h.bet, done: h.done,
          result: h.result, resultCls: h.resultCls
        }))
      })),
    you: you ? youId : null,
    log: g.log.slice(-12)
  };
  if (you) {
    const acc = accounts.get(you.token);
    if (acc) snap.cage = { cash: acc.cash };
  }
  return snap;
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

    if (opcode === 0x8) { // close
      try { conn.socket.write(wsFrame(0x8, Buffer.alloc(0))); } catch (e) {}
      killConn(conn);
      return;
    }
    if (opcode === 0x9) { // ping -> pong
      try { conn.socket.write(wsFrame(0xA, payload)); } catch (e) {}
      continue;
    }
    if (opcode === 0xA) { // pong: proof of life
      conn.lastPong = Date.now();
      const g = rooms.get(conn.room);
      if (g) {
        const p = playerById(g, conn.playerId);
        if (p) p.lastSeen = Date.now();
      }
      continue;
    }
    // text messages from clients are just keepalive/no-op for now
  }
}

// server ping every 25s keeps proxies (Railway) from idling the socket out
setInterval(() => {
  for (const g of rooms.values()) {
    for (const conn of g.conns) {
      if (conn.dead) continue;
      if (Date.now() - conn.lastPong > 70000) { killConn(conn); continue; }
      try { conn.socket.write(wsFrame(0x9, Buffer.alloc(0))); } catch (e) { killConn(conn); }
    }
  }
}, 25000).unref();

// ---------- http plumbing ----------
function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
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
      if (inf.family === 'IPv4' && !inf.internal) {
        urls.push('http://' + inf.address + ':' + PORT);
      }
    }
  }
  return urls;
}

function normalizeRoom(code) {
  code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return (code.length >= 3 && code.length <= 8) ? code : '';
}

const STATIC_FILES = {
  '/': 'table.html',
  '/table.html': 'table.html',
  '/vegas-playbook.html': 'vegas-playbook.html',
  '/blackjack-trainer.html': 'blackjack-trainer.html',
  '/admin': 'admin.html',
  '/admin.html': 'admin.html'
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
    if (p === '/api/info' && req.method === 'GET') {
      sendJSON(res, 200, { name: 'TABLE SEVEN', port: PORT, urls: lanUrls() });
      return;
    }
    if (req.method === 'POST' && p.startsWith('/api/')) {
      const body = await readBody(req);

      if (p === '/api/admin/overview' || p === '/api/admin/credit') {
        if (!isAdmin(body.key)) {
          await new Promise(r => setTimeout(r, 300)); // slow down guessing
          sendJSON(res, 403, { error: 'Wrong pit boss key.' });
          return;
        }
        if (p === '/api/admin/overview') {
          const seatedAt = {};
          for (const g of rooms.values())
            for (const q of g.players) seatedAt[q.token] = g.code;
          const accs = [...accounts.entries()].map(([token, acc]) => ({
            token,
            name: acc.name || '(unnamed)',
            cash: acc.cash,
            comps: acc.comps || 0,
            seated: seatedAt[token] || null
          })).sort((x, y) => y.cash - x.cash);
          const tables = [...rooms.values()].map(g => ({
            code: g.code, phase: g.phase, round: g.round,
            players: g.players.map(q => ({
              name: q.name, chips: q.bankroll, connected: isPresent(g, q)
            }))
          }));
          sendJSON(res, 200, { accounts: accs, tables });
          return;
        }
        // credit / dock a cage account
        const acc = accounts.get(String(body.token || ''));
        if (!acc) { sendJSON(res, 400, { error: 'No such account.' }); return; }
        const amount = Math.round(Number(body.amount) || 0);
        if (!amount || Math.abs(amount) > 100000) {
          sendJSON(res, 400, { error: 'Amount must be between −$100,000 and $100,000 (not zero).' });
          return;
        }
        acc.cash = Math.max(0, acc.cash + amount);
        saveCageSoon();
        for (const g of rooms.values()) {
          const q = g.players.find(pp => pp.token === body.token);
          if (q) {
            log(g, amount > 0
              ? 'The pit boss credits ' + q.name + '’s cage account ' + fmt(amount) + '.'
              : 'The pit boss docks ' + q.name + '’s cage account ' + fmt(-amount) + '.');
          }
        }
        sendJSON(res, 200, { ok: true, cash: acc.cash });
        return;
      }

      if (p === '/api/account') {
        const { token, acc, created, comped } = getAccount(body.token);
        if (body.name) acc.name = String(body.name).replace(/[^A-Za-z0-9 _.'-]/g, '').trim().slice(0, 14);
        sendJSON(res, 200, { token, cash: acc.cash, name: acc.name, created, comped });
        return;
      }

      if (p === '/api/join') {
        const name = String(body.name || '').replace(/[^A-Za-z0-9 _.'-]/g, '').trim().slice(0, 14);
        if (!name) { sendJSON(res, 400, { error: 'Need a name (letters and numbers).' }); return; }
        const { token, acc } = getAccount(body.token);
        const buyIn = Math.floor(Number(body.buyIn) || 0);
        if (buyIn < 50 || buyIn > 2000) { sendJSON(res, 400, { error: 'Buy in for $50 to $2,000.' }); return; }
        if (buyIn > acc.cash) { sendJSON(res, 400, { error: 'The cage says you only have ' + fmt(acc.cash) + '.' }); return; }
        let code = normalizeRoom(body.room);
        let g = code ? rooms.get(code) : null;
        if (!g) {
          if (rooms.size >= MAX_ROOMS) { sendJSON(res, 503, { error: 'Too many tables open right now — try again in a bit.' }); return; }
          if (!code) code = newCode();
          g = freshGame(code);
          rooms.set(code, g);
        }
        if (g.players.length >= 4) { sendJSON(res, 400, { error: 'That table is full (4 seats).' }); return; }
        acc.name = name;
        acc.cash -= buyIn;
        saveCageSoon();
        const taken = g.players.map(q => q.seat);
        let seat = 1;
        while (taken.includes(seat)) seat++;
        const np = freshPlayer(name, seat, token, buyIn);
        g.players.push(np);
        log(g, name + ' buys in for ' + fmt(buyIn) + ' — seat ' + seat + '.');
        sendJSON(res, 200, { playerId: np.id, seat, room: code, token, cash: acc.cash });
        return;
      }

      const g = rooms.get(normalizeRoom(body.room));
      if (!g) { sendJSON(res, 400, { error: 'That table has closed — join again.' }); return; }
      const player = body.playerId ? playerById(g, body.playerId) : null;
      if (!player) { sendJSON(res, 400, { error: 'Unknown player — join first.' }); return; }
      player.lastSeen = Date.now();

      if (p === '/api/bet') {
        if (g.phase !== 'betting') { sendJSON(res, 409, { error: 'Betting is closed.' }); return; }
        const amt = Math.floor(Number(body.amount) || 0);
        if (amt !== 0 && (amt < 5 || amt > 500)) { sendJSON(res, 400, { error: 'Bet $5 to $500 (or 0 to sit out).' }); return; }
        if (amt > player.bankroll) { sendJSON(res, 400, { error: 'That is more than your chips.' }); return; }
        player.bet = amt;
        bump(g);
        sendJSON(res, 200, { ok: true });
        return;
      }
      if (p === '/api/deal') {
        if (g.phase !== 'betting') { sendJSON(res, 409, { error: 'A round is already going.' }); return; }
        if (player.bet < 5) { sendJSON(res, 400, { error: 'Put a bet in your circle first.' }); return; }
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
        sendJSON(res, 200, { ok: true });
        return;
      }
      if (p === '/api/rebuy') {
        if (g.phase !== 'betting') { sendJSON(res, 409, { error: 'Wait for the betting phase.' }); return; }
        const { acc } = getAccount(player.token);
        const amount = Math.min(300, acc.cash);
        if (amount < 5) { sendJSON(res, 400, { error: 'The cage says your account is empty. It will stake you when you rejoin.' }); return; }
        acc.cash -= amount;
        saveCageSoon();
        player.bankroll += amount;
        player.rebuys++;
        log(g, player.name + ' rebuys ' + fmt(amount) + ' from the cage.');
        sendJSON(res, 200, { ok: true, cash: acc.cash });
        return;
      }
      if (p === '/api/leave') {
        if (g.phase !== 'betting' && g.phase !== 'settle' && player.inRound) {
          sendJSON(res, 409, { error: 'Finish the hand first.' }); return;
        }
        const cash = colorUp(g, player, 'heads to the cage.');
        for (const conn of g.conns) if (conn.playerId === player.id) killConn(conn);
        bump(g);
        sendJSON(res, 200, { ok: true, cash });
        return;
      }
      sendJSON(res, 404, { error: 'No such endpoint.' });
      return;
    }

    // ----- static files (allowlist only) -----
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
  const conn = {
    socket, room: code, playerId,
    buffer: Buffer.alloc(0), dead: false, lastPong: Date.now()
  };
  if (!g || !playerById(g, playerId)) {
    try { socket.write(wsFrame(0x1, Buffer.from(JSON.stringify({ noRoom: true, version: 0 })))); } catch (e) {}
    setTimeout(() => { try { socket.destroy(); } catch (e) {} }, 100);
    return;
  }
  g.conns.add(conn);
  const player = playerById(g, playerId);
  player.lastSeen = Date.now();
  socket.on('data', d => handleWsData(conn, d));
  socket.on('close', () => killConn(conn));
  socket.on('error', () => killConn(conn));
  socket.on('end', () => killConn(conn));
  wsSend(conn, JSON.stringify(snapshot(g, playerId)));
});

loadCage();
server.listen(PORT, () => {
  console.log('');
  console.log('  ♠ ♥  T A B L E   S E V E N  ♦ ♣');
  console.log('  The casino is open on port ' + PORT + '  (live websockets + cage accounts)');
  console.log('');
  console.log('  Play here:            http://localhost:' + PORT);
  for (const u of lanUrls()) {
    console.log('  Same-WiFi players:    ' + u);
  }
  console.log('');
  console.log('  Every visitor gets a $' + START_CASH + ' cage account (saved in cage-data.json).');
  console.log('  Each table gets a private code — share the link the page shows you.');
  console.log('');
  console.log('  Pit Boss console:     http://localhost:' + PORT + '/admin');
  console.log('  Pit Boss key:         ' + ADMIN_KEY +
    (process.env.TABLE_ADMIN_KEY ? '  (from TABLE_ADMIN_KEY)' : '  (random this boot — set TABLE_ADMIN_KEY to fix it)'));
  console.log('  Also served: /vegas-playbook.html and /blackjack-trainer.html');
  console.log('  Press Ctrl+C to close the casino.');
  console.log('');
});
