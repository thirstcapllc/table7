# TABLE SEVEN v5 — casino platform

A ground-up rewrite of Table Seven as a **multi-game casino platform** with one
shared **cage** (accounts, chips, comps, history) that every game draws on.
Games are modules: blackjack first, then Texas Hold'em, then keno/bingo/slots.

Live `table7.foundinvegas.com` (the v1–v3 single-file app in the repo root) keeps
running untouched while this is built. v5 ships when it's at parity.

## Stack

| Layer      | Choice                                   | Why |
|------------|------------------------------------------|-----|
| Language   | TypeScript everywhere                    | Type safety end-to-end |
| Backend    | **NestJS** (Express adapter)             | Modular — each game is a Nest module on the shared cage |
| Real-time  | **Socket.IO** (`@nestjs/websockets`)     | Rooms, reconnect, presence — replaces the hand-rolled WS |
| Database   | **Postgres** via **Prisma**              | Type-safe queries; the centralized cage. (SQLite for local dev.) |
| Frontend   | **React + Vite** (TS)                    | Shared components: card, cage, chip rack, table |
| Monorepo   | npm workspaces                           | `server` + `web` + shared `types` |

## Layout

```
v5/
  package.json            # npm workspaces root
  server/                 # NestJS API + Socket.IO gateways
    prisma/schema.prisma  # the shared cage schema
    src/
      cage/               # accounts, chips, transactions, comps  (game-agnostic)
      auth/               # player Player#/PIN + staff/owner admin
      games/
        blackjack/        # first game module
        poker/            # second game module (Texas Hold'em)
      realtime/           # Socket.IO gateway + room registry
  web/                    # React + Vite client (added next)
  packages/types/         # shared TS types between server & web
```

## The cage boundary (why games stay clean)

Games never touch money directly. They call the **CageService**:

- `buyIn(token, tableId, amount)` → moves cage cash to a table seat, logs a `buyin` tx
- `settle(token, tableId, delta, meta)` → applies a win/loss, logs it, awards comps
- `cashOut(token, tableId)` → returns table chips to the cage, logs a `cashout` tx
- `history(token)` → the player's own credits/debits + per-hand log

So a game module only implements *rules + table state*; the platform owns
identity, money, comps, tiers, audit history, and the admin console. Adding a
game = adding a module + a Socket.IO namespace, nothing in the cage changes.

## Status

- [x] Monorepo + server scaffold, shared cage schema, health + account endpoints
- [ ] Auth (Player#/PIN, staff/owner), Socket.IO gateway, room registry
- [ ] Blackjack module (port rules from the v1 engine — it's already well-tested)
- [ ] React client (shared components, blackjack table)
- [ ] Texas Hold'em module
- [ ] Deploy pipeline (Railway service, Postgres, custom domain)
