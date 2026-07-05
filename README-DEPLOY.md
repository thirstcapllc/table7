# TABLE SEVEN — deploy guide

Private multiplayer blackjack with a basic-strategy coach. One Node server
(`table-server.js`) serves the landing page (`/`), the live table (`/play`),
the solo trainer (`/blackjack-trainer.html`), the Vegas playbook
(`/vegas-playbook.html`), a donation page (`/donate`), and legal pages
(`/privacy.html`, `/terms.html`). Old share links to `/?t=CODE` auto-forward
into `/play?t=CODE`. The only dependency is `pg` (Postgres client); with no
`DATABASE_URL` set it falls back to a local JSON file and needs nothing.

Every game lives at a table code (share link like `/?t=K7Q4`). Public tables
show up in the lobby for anyone to join; private ones are join-by-code only, so
strangers who find the site can't wander into your game.

## Tables, hosts, bots & rules

- **The lobby** lists open public tables (host, seats, rules) — click to sit.
  Private tables are hidden and joined only by their code.
- **The host** is the first human to sit at a table. Only the host can add/remove
  bots and change the house rules (between hands): **table min/max bets**,
  blackjack payout **3:2 or 6:5**, number of **decks** (1/2/4/6/8), dealer
  **hits or stands soft 17**, **double after split** on/off, and **late
  surrender** on/off.
- **Comps & membership**: players earn 1 comp point per $1 wagered, which sets
  a membership tier (Bronze → Silver → Gold → Platinum) shown on their animated
  digital players card at signup/login and in the admin console.
- **Bots** fill empty seats and play themselves — "book" bots play perfect basic
  strategy, "loose" bots make tourist mistakes. They use house money, never the cage.
- **Cash out** any time from the betting screen (or after a hand) — you drop back
  to the lobby with your chips banked, not forced into another hand.

## Run it at home

Double-click `Start-TableSeven.cmd` (or `node table-server.js`). Anyone on your
WiFi joins with the link the page shows you.

## Deploy on Railway

1. Push this folder to a GitHub repo (the included `.gitignore` keeps the
   unrelated projects and local data files out). All the `.html` files,
   `table-server.js`, `store.js`, `package.json`, and `.gitignore` are needed.
2. On [railway.app](https://railway.app): **New Project → Deploy from GitHub repo**
   and pick the repo. Railway detects `package.json`, runs `npm install`
   (installs `pg`) and `npm start`. The server honors Railway's `PORT`.
3. In the service settings, open **Networking → Generate Domain** to get a
   `*.up.railway.app` URL and confirm it works.

## Database (persist across redeploys) — do this before inviting real players

Without a database, cage balances and history reset on every redeploy. To make
them permanent:

1. In your Railway project: **New → Database → Add PostgreSQL**.
2. Open your **table7** service (the app, not the database) → **Variables →
   New Variable**: name `DATABASE_URL`, value `${{ Postgres.DATABASE_URL }}`
   (Railway resolves the reference to the private connection). Save — it
   redeploys.
3. On boot the server creates its tables automatically (`accounts`,
   `transactions`, `hands`) and prints `Storage: Postgres` in the deploy logs.
   It retries the connection a few times to ride out the cold-start race, and
   picks SSL by host (plaintext for the private `.railway.internal` URL, TLS
   for the public proxy URL), so either `DATABASE_URL` works.
4. Verify: play a hand, redeploy, and confirm your balance survived.

## Point your subdomain at it

Suggested subdomain: **table7.yourdomain.com** (short, on-brand).

1. Railway → your service → **Settings → Networking → Custom Domain** → enter
   `table7.yourdomain.com`. Railway shows you a CNAME target.
2. At your DNS provider, add a CNAME record: name `table7`, value the target
   Railway gave you. Wait a few minutes for DNS, then Railway issues HTTPS
   automatically.

## The Pit Boss console

`/admin` is the house control room: see every cage account (Player #, name,
membership tier, comp points, cash), credit or dock cage cash, reset a
forgotten PIN, delete accounts, and view a full **History** per account (every
buy-in, cash-out, rebuy, admin adjustment, and hand-by-hand result).

Two ways to sign in:

- **Owner** — the `TABLE_ADMIN_KEY` env var (printed in the server console if
  unset). The owner can do everything, including managing staff, and can never
  be locked out. Set `TABLE_ADMIN_KEY` in Railway's service Variables for a
  permanent owner key.
- **Staff** — the owner adds staff admins (username + password, stored hashed
  in the DB) in the console's Staff section. Staff can run the pit (credit,
  reset PINs, view history) but can't manage other staff. Logins are
  session-based (8-hour sessions), so nothing sensitive is stored in the browser.

## Good to know

- **Live websockets** (hand-rolled, still zero dependencies): state is pushed
  instantly, and if someone closes their tab the table banks their chips at
  the cage and frees the seat within seconds. Falls back to polling if a
  proxy blocks websockets. Railway supports websockets out of the box.
- **The cage**: every visitor gets an account staked with $1,000. A short
  onboarding screen shows first-time players their Player # + PIN with a copy
  button and a "save this" checkbox before they can continue. Balances and
  history live in Postgres when `DATABASE_URL` is set (survive redeploys),
  or a local `cage-data.json` otherwise.
- **Rate limiting**: every `POST /api/*` is throttled per IP (strict on login
  and admin endpoints, moderate on join/account, generous for gameplay).
  Exceeding a limit returns `429` with a `Retry-After` header. Client IP is
  read from `x-forwarded-for` (correct behind Railway's proxy).
- **Legal + donations**: `/privacy.html`, `/terms.html`, and `/donate`
  (PayPal hosted button) are linked from the landing and lobby. The legal
  pages are plain-language summaries for a free play-money game — get a lawyer
  to review them before a wide public launch.
- **Player # + PIN**: each account shows a 6-digit Player # and 4-digit PIN in
  the lobby. The browser normally remembers you, but if a player clears their
  cookies (or switches devices) they can type their Player # + PIN into the
  "Log back in" box to reclaim their chips. The Pit Boss console lists Player #s.
- Open tables live in memory: a restart or redeploy closes them (cage
  balances and history survive in Postgres; everyone just rejoins).
- Tables close themselves after ~20 minutes with no humans around; max 50 tables
  at once; up to 6 seats per table (players + bots).
- Only an explicit allowlist of pages is ever served (landing, `/play`,
  playbook, trainer, admin, donate, privacy, terms) — nothing else in the
  repo/folder (server code, `store.js`, data files) is reachable over HTTP.
