# Word Craft deployment notes

Last updated: 2026-09-06
Repository: `https://github.com/abhijitgite12/wordcraft`
Local project: `/home/abhijitgite/dev/src/satvocab`
Previous Render service: `wordcraft` (deleted after Docker migration)
Previous service ID: `srv-dadfa967bikc73bvnup0`
Previous URL: `https://wordcraft-6tuz.onrender.com` (retired — returns 404; do not use)
Current URL: `https://wordcraft-docker.onrender.com`
Docker migration service: `wordcraft-docker`
Docker service ID: `srv-dadka58n74is73adu990`
Docker URL: `https://wordcraft-docker.onrender.com`
Git branch: `master`

## Current deployment model

Word Craft is intended to use the committed Dockerfile for both local and Render deployments:

- Base image: `node:22-alpine`
- Install: `npm install --omit=dev`
- Start command: `node server.js`
- Runtime data: `words.json` and `data/sat.duckdb`
- Server is read-only in production: `ALLOW_RW=0`
- Learner progress is stored in browser localStorage

`render.yaml` declares:

```yaml
runtime: docker
dockerfilePath: ./Dockerfile
dockerContext: .
autoDeploy: true
```

Important: an existing Render service may retain its old runtime even after `render.yaml` changes. Verify the actual service with the Render CLI, not only the file in GitHub.

## Git workflow

Git credentials are managed by the local GitHub CLI credential helper. Do not put tokens or passwords in this file, the repository, or shell history.

```bash
cd /home/abhijitgite/dev/src/satvocab
git status
git log --oneline -5
git push origin master
```

The GitHub repository is `abhijitgite12/wordcraft`; the configured remote is `origin`.

## Render CLI workflow

The Render CLI is installed at `/home/abhijitgite/.local/bin/render` and is already authenticated. Never print or commit its token.

Check service configuration:

```bash
render services --output json
```

Important: Render treats the runtime as immutable for an existing service. `render services update --runtime docker` is rejected with `cannot switch runtimes via the CLI`; the API update also does not change the existing runtime. A parallel Docker service was created successfully: `wordcraft-docker` (`srv-dadka58n74is73adu990`). Its environment variables were transferred securely and its deployment is live.

Safest migration: create a parallel Docker service, verify it, confirm its environment variables, then switch users to its URL before deleting the old Node service:

```bash
render services create \
  --from srv-dadfa967bikc73bvnup0 \
  --name wordcraft-docker \
  --runtime docker \
  --repo https://github.com/abhijitgite12/wordcraft \
  --branch master \
  --health-check-path /login \
  --auto-deploy \
  --confirm \
  --output json
```

The original Node service was deleted only after the Docker URL was verified. The Docker service has been verified: `/login`, `/style.css`, and `/app.js` all return HTTP 200. Required environment variables were transferred: `APP_PASSWORD`, `OPENROUTER_API_KEY`, `SESSION_SECRET`, and `ALLOW_RW`.

## Passwords (two different values)

- **Local Docker:** set in `.env` (`APP_PASSWORD`) — currently `wordcraft-local` (never commit the real value).
- **Render production:** set in the Render dashboard env vars — differs from the local `.env` value.
- `POST /api/login` returns `200` on success, `401` on bad password (rate-limited after repeated failures).
- Note: `GET /login` may return a `401` status header while still serving the login page HTML in the body; check the body or use the POST check above.

## Auto-deploy: push → Render (no scripts, no hooks)

Deploy-on-push is Render's built-in GitHub integration — there is **no local git hook, no post-push script, and no GitHub Action**. Verified 2026-09-06:

- No `.git/hooks/pre-push` / `post-push` (only default samples); `core.hooksPath` unset.
- No `.github/workflows/` in the repo.

The trigger is configured in two places:

1. Repo: `render.yaml` → `autoDeploy: true`
2. Render service (check with `render services --output json`): `autoDeploy = yes`, `autoDeployTrigger = commit`, `branch = master`, `repo = abhijitgite12/wordcraft`

In the Render dashboard: **Settings → Build & Deploy** shows "Auto-Deploy: Yes, on every commit to master"; the **Deploys tab** shows each deploy's trigger (`github` = auto from push, `api` = manual CLI deploy).

Quirk: a manual `render deploys create` for the same commit deduplicates the auto-deploy that the push also fires. Either way the commit goes live. To watch auto-deploy work on its own, push a trivial change and look for a `github`-triggered entry in the Deploys tab within seconds.

Deploy an exact Git commit and wait for Render's result on the service:

```bash
render deploys create srv-dadka58n74is73adu990 \
  --commit "$(git rev-parse HEAD)" \
  --wait \
  --confirm
```

If the service is already Docker but appears stuck:

```bash
render restart srv-dadka58n74is73adu990 --confirm
```

After deployment, verify the public assets, not only `/login` (use the CURRENT URL):

```bash
curl -I --max-time 30 https://wordcraft-docker.onrender.com/login
curl -I --max-time 30 'https://wordcraft-docker.onrender.com/style.css?v=deploycheck'
curl -I --max-time 30 'https://wordcraft-docker.onrender.com/app.js?v=deploycheck'
```

Better: check the response *bodies* for the latest frontend feature (status codes alone can be misleading):

```bash
curl -s 'https://wordcraft-docker.onrender.com/style.css?v=deploycheck' | grep -o 'fs-row'   # font-size adjuster (2026-09-06)
curl -s 'https://wordcraft-docker.onrender.com/app.js?v=deploycheck'  | grep -o 'applyFontSize'
```

## Local Docker verification

```bash
cd /home/abhijitgite/dev/src/satvocab
docker build -t wordcraft:local .
docker compose up -d --build
curl -I http://localhost:4173/login
```

## Data / DB workflow

`words.json` contains 5,908 vocabulary words with `aiDefinition`. The local DB and Parquet export must be rebuilt when the data changes:

```bash
node db_build.js
git add words.json data/sat.duckdb data/sat_words.parquet db_build.js
git commit -m "Update vocabulary definitions and database"
git push origin master
```

Never commit API keys, Render tokens, passwords, `.env`, or local AI burn progress files.

## Recent changes (2026-09-06)

- **Voice interaction layer (new):** 🎙 button in header + text-input fallback. Local fast-path matcher handles common commands (next/back/skip/repeat/reveal/options/help/mute/stop/answer A-D) with zero network; free-model `/api/intent` endpoint handles garbled/ambiguous/free-speech utterances. See `TOOL_CALLING.md`, `ACTION_MATRIX.md`, `VOICE_FLOW.md`.
- **Vocal agent (most recent):** always-on continuous listening (toggle mic on), Grok-style status pill (off ☁️ listening/hearing/thinking/speaking) with live transcript caption, and a `/api/agent` endpoint that is truly agentic — full page context (screen/word/definition/options/legal tools) + per-session rolling memory, decides one action + spoken narration, and grades free-spoken meanings (verdict 0/1/2). Reflexive local fast-path still executes instant commands with zero network.
- Text size adjuster added in the 🎨 theme menu (A− / A+, 85%–140% in 10% steps). Scales card typography via the `--fs` CSS variable; persisted per browser in localStorage key `wordCraftFont`. Commit `0778e2e`, verified live on Render.
- Cache-bust versions when editing `public/` files: current are `style.css?v=wordcraft8` and `app.js?v=wordcraft7` (bump these on further changes so browsers pick up updates).
- Theme-menu JS selects buttons via `.theme-menu [data-theme]` — new non-theme buttons added to the theme menu must either carry no `data-theme` or opt out of that selector.

## Current application changes

- AI-cleaned learner definitions are stored as `aiDefinition`.
- Deep Dive has a prompt-specific `directAnswer` field and highlighted target-word occurrences.
- Help modal explains mobile swipes, desktop controls, keyboard navigation, and Quick Test keys.
- Card navigation includes Back/Next buttons.
- Card dragging uses pointer tracking, tilt, resistance, fling threshold, and spring-back.
- Public `/style.css` and `/app.js` assets are explicitly served through the unauthenticated login guard.

## Troubleshooting

- If Render reports native Node after changing `render.yaml`, update the existing service with `render services update ... --runtime docker`; an existing service is not always reconciled automatically from the blueprint file.
- If `/login` works but CSS/JS hangs, inspect the deployed service runtime and deploy logs with the Render CLI, then manually redeploy the exact Git commit.
- If AI calls fail, verify `OPENROUTER_API_KEY` in Render's environment variables. Never place it in Git.
- Required Render environment variables: `APP_PASSWORD`, `OPENROUTER_API_KEY`, `SESSION_SECRET`; production should keep `ALLOW_RW=0`.
