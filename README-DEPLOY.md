# TABLE SEVEN — deploy guide

Private multiplayer blackjack with a basic-strategy coach. Zero dependencies —
one Node server (`table-server.js`) serves the live table (`/`), the solo
trainer (`/blackjack-trainer.html`), and the Vegas playbook (`/vegas-playbook.html`).

Every game lives at a private table code (share link like `/?t=K7Q4`), so
strangers who find the site can't wander into your game.

## Run it at home

Double-click `Start-TableSeven.cmd` (or `node table-server.js`). Anyone on your
WiFi joins with the link the page shows you.

## Deploy on Railway

1. Push this folder to a GitHub repo (the included `.gitignore` keeps the
   unrelated projects out):
   ```
   git init
   git add table-server.js table.html admin.html vegas-playbook.html blackjack-trainer.html package.json README-DEPLOY.md Start-TableSeven.cmd .gitignore
   git commit -m "Table Seven v1"
   ```
   Then create a repo on GitHub and `git push`.
2. On [railway.app](https://railway.app): **New Project → Deploy from GitHub repo**
   and pick the repo. Railway detects `package.json` and runs `npm start`.
   The server honors Railway's `PORT` automatically — no config needed.
3. In the service settings, open **Networking → Generate Domain** to get a
   `*.up.railway.app` URL and confirm it works.

## Point your subdomain at it

Suggested subdomain: **table7.yourdomain.com** (short, on-brand).

1. Railway → your service → **Settings → Networking → Custom Domain** → enter
   `table7.yourdomain.com`. Railway shows you a CNAME target.
2. At your DNS provider, add a CNAME record: name `table7`, value the target
   Railway gave you. Wait a few minutes for DNS, then Railway issues HTTPS
   automatically.

## The Pit Boss console

`/admin` is the house control room: see every cage account and open table,
and credit (or dock) anyone's cage cash. It's protected by a key:

- Locally the key is printed in the server console at every start.
- For a permanent key (do this on Railway): set the `TABLE_ADMIN_KEY`
  environment variable in your service settings, then open
  `https://table7.yourdomain.com/admin` and enter it once — it's remembered
  in that browser.

## Good to know

- **Live websockets** (hand-rolled, still zero dependencies): state is pushed
  instantly, and if someone closes their tab the table banks their chips at
  the cage and frees the seat within seconds. Falls back to polling if a
  proxy blocks websockets. Railway supports websockets out of the box.
- **The cage**: every visitor gets a persistent account staked with $1,000
  (stored in `cage-data.json` next to the server). Buy chips into a table,
  color up when you leave — winnings survive between sessions. On Railway the
  file resets on each redeploy; attach a Railway Volume mounted at the app
  directory if you want the ledger to survive deploys.
- Open tables live in memory: a restart or redeploy closes them (cage
  balances survive if the file does; everyone just rejoins).
- Tables close themselves after ~20 minutes with nobody around; max 50 tables
  at once; 4 seats per table.
- Only the five game pages are ever served — nothing else in the repo/folder
  is reachable from the internet.
