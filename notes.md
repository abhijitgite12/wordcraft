# Word Craft deployment notes

Last updated: 2026-09-04
Repository: `https://github.com/abhijitgite12/wordcraft`
Local project: `/home/abhijitgite/dev/src/satvocab`
Original Render service: `wordcraft`
Original service ID: `srv-dadfa967bikc73bvnup0`
Original URL: `https://wordcraft-6tuz.onrender.com`
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

Do not delete the original Node service until the Docker URL has been accepted as the replacement. The Docker service has been verified: `/login`, `/style.css`, and `/app.js` all return HTTP 200. Required environment variables were transferred: `APP_PASSWORD`, `OPENROUTER_API_KEY`, `SESSION_SECRET`, and `ALLOW_RW`.

Deploy an exact Git commit and wait for Render's result on a service:

```bash
render deploys create srv-dadfa967bikc73bvnup0 \
  --commit "$(git rev-parse HEAD)" \
  --wait \
  --confirm
```

If the service is already Docker but appears stuck:

```bash
render restart srv-dadfa967bikc73bvnup0 --confirm
```

After deployment, verify the public assets, not only `/login`:

```bash
curl -I --max-time 30 https://wordcraft-6tuz.onrender.com/login
curl -I --max-time 30 'https://wordcraft-6tuz.onrender.com/style.css?v=deploycheck'
curl -I --max-time 30 'https://wordcraft-6tuz.onrender.com/app.js?v=deploycheck'
```

Expected status is `200` for all three. A working `/login` with hanging CSS/JS usually means the old service/runtime is still serving or a deploy is unhealthy.

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
