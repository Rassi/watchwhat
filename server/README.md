# watchwhat-sync

The sync backend on Cloudflare Workers + D1: an append-only event log of what
happened, plus a small mutable table of settings. Design and reasoning live in
[`../docs/sync-plan.md`](../docs/sync-plan.md).

This directory is independent of the app. It has its own `package.json` and
`tsconfig.json`, and the root build (`tsc` with `"include": ["src"]`) does not see
it, so nothing here can break the Pages deploy.

## API

Both endpoints need `Authorization: Bearer <SYNC_TOKEN>`.

| | |
|---|---|
| `GET /events?since=<seq>` | `{ events, seq, more }` — up to 500 events after the cursor, oldest first. Keep calling while `more` is true, passing the returned `seq`. |
| `POST /events` | `{ events: [{ id, device, ts, kind, body }] }` → `{ accepted, seq }`. Up to 1000 per request. `id` is a client-generated UUID and re-sending one is a no-op, so retrying after a dropped response is always safe. |
| `GET /settings` | `{ settings: { key: { value, updated } } }` — every setting held, no paging. |
| `PUT /settings` | Same shape in, and the full post-write state back. Upserts per key, and **rejects any field whose `updated` is not newer than the stored one**, so a device flushing a stale offline edit cannot clobber a newer one. `value: null` means "back on the app's default" and is how a Reset travels. |

Settings are deliberately not events: they are mutable state, so an append-only
log would accumulate every API key ever rotated — and, more to the point, they
have to be readable *before* replay starts, since replay resolves unseen titles
against TMDB and a key arriving mid-log would mean everything ahead of it was
silently skipped. The client therefore reconciles settings first on every sync.

## First-time setup

`wrangler login` opens a browser, so run these yourself — in Claude Code, prefix
with `!` to run them in-session.

```sh
cd server
npm install
npx wrangler login

# Create the database, then paste the printed database_id into wrangler.toml.
npx wrangler d1 create watchwhat

npm run schema          # apply schema.sql to the remote database

# A long random token. Paste the same value into the app's Settings on each device.
npx wrangler secret put SYNC_TOKEN

npm run deploy
```

Generate a token with `openssl rand -base64 32`, or in PowerShell:

```powershell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Max 256 }))
```

## Local development

`wrangler dev` reads secrets from `.dev.vars` (gitignored) rather than the
deployed secret:

```sh
echo 'SYNC_TOKEN=whatever-you-like-locally' > .dev.vars
npm run schema:local
npm run dev
```

`http://localhost:5173` is already in the allowed CORS origins, so the Vite dev
server can talk to a local Worker.

## Checking it works

```sh
curl -H "Authorization: Bearer $TOKEN" "http://localhost:8787/events?since=0"

curl -X POST "http://localhost:8787/events" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"events":[{"id":"11111111-1111-1111-1111-111111111111","device":"test","ts":"2026-08-01T12:00:00Z","kind":"movie.watched","body":{"movie":550,"at":"2026-08-01T12:00:00Z"}}]}'
```

Posting that same line twice should report `accepted: 1` both times while `seq`
stays put — that is the idempotency the outbox depends on.

## Notes

- **The repo is public.** `SYNC_TOKEN` is a Worker secret and a `localStorage`
  value on each device. It must never appear in a committed file. `database_id`
  in `wrangler.toml` is an identifier, not a credential, and is fine to commit.
- The token now also guards the TMDB and OMDb keys, since those live in
  `settings`. Both are free and read-only, and anyone holding the token could
  already read the whole watch history, so the blast radius barely moves — but it
  is one more reason for the token to be long, random, and rotated rather than
  shared.
- The server interprets neither an event nor a setting: a `kind` is a string and
  a setting is a key with opaque JSON. Adding either needs no change here.
- `schema.sql` is all `IF NOT EXISTS`, so **re-running `npm run schema` is how a
  new table reaches the live database.** It is additive and safe to repeat.
