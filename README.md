# Word Craft

An adaptive, swipe-based SAT/GRE vocabulary study app. 5,908 words with difficulty + category tags, DuckDB + Parquet-backed search, an OpenRouter-backed Deep Dive tutor, and per-browser progress.

## Run locally (Docker — same image used by Render)

```bash
cd ~/dev/src/satvocab
export OPENROUTER_API_KEY="your-key"        # for Deep Dive (optional locally)
export APP_PASSWORD="your-password"          # password gate
docker compose up --build
# open http://localhost:4173
```

### Run locally without Docker

```bash
node server.js
# open http://localhost:4173
```

## Deploy to Render (free)

Render uses the committed `Dockerfile` via `render.yaml`, so local Docker and production use the same Node 22 image, dependency installation, filesystem layout, and start command.

1. Push this folder to a GitHub repo.
2. On [render.com](https://render.com) → **New → Web Service** → connect the repo.
3. It auto-detects `render.yaml`.
4. In the Render dashboard set these **env vars** (never in the repo):
   - `APP_PASSWORD` — the gate password
   - `OPENROUTER_API_KEY` — for Deep Learning
   - `SESSION_SECRET` — random: `openssl rand -hex 32`
   - `ALLOW_RW=0` — run read-only on the ephemeral free disk
5. Deploy. Render gives you `https://wordcraft.onrender.com`.

> **Why read-only?** Render free web services have an **ephemeral filesystem** — it's wiped on every redeploy/spin-down. All learner progress is stored in the **browser's localStorage** (score, wrong-words, streak, theme, volume), not the server disk, so it survives. The committed `data/sat.duckdb` is read-only and rebuilt from the repo. AI-generated examples are cached in-memory + browser storage.

## Auth

- Password-protected via `APP_PASSWORD` (constant-time compare, never stored).
- Sessions are HMAC-signed cookies that survive restarts / spin-downs.
- A word can carry multiple categories (`SAT 🔥`, `GRE`, `Core`, `Academic`).

## Study features

- Swipe-only feed: **teach → test → relearn-on-miss**
- Difficulty (Easy/Med/Hard) + category filters
- OpenRouter free models for Deep Dive (cached examples + "another example")
- Soft classical study music (public-domain MIDI, synthesized in-browser; ~5-min pieces rotate)
- 10 color themes, optional confetti on correct answers
- Browse bank (DuckDB search)

## Data & storage

- `words.json` — full word bank (commit-able)
- `data/sat.duckdb` + `data/sat_words.parquet` — read-only lookup/search DB (built by `node db_build.js` from `words.json`)
- `public/midi/*.mid` — public-domain classical MIDI (Fur Elise, Moonlight Sonata, Turkish March, Canon in D, Clair de Lune)
- Progress: browser `localStorage` only

## Env vars

| Var | Purpose |
|---|---|
| `APP_PASSWORD` | Password gate (required for deployed access) |
| `OPENROUTER_API_KEY` | Deep Dive AI (server-side only) |
| `SESSION_SECRET` | HMAC session signing |
| `ALLOW_RW` | `1` = allow disk writes (dev only); `0` = read-only |
| `PORT` | HTTP port |