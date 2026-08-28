# Slack Events → Cursor webhook proxy

Public HTTPS hop between Slack Event Subscriptions and a Cursor Grok Bot webhook.

Slack POSTs JSON to a Request URL and **cannot** send `Authorization`. Cursor webhooks require `Authorization: Bearer <key>` and reject keys in the URL. Slack also requires `url_verification`: the Request URL must respond HTTP 200 with the `challenge` value. The Cursor webhook returns `{success:true,runUuid}` instead, so Slack verification fails even if you could attach a header.

This repo is that missing hop. **Vercel** is the deploy path. A Cloudflare Worker is still in the tree if you want it; you do not need both.

Repo: [stealth-bots/grok-bot-slack-events-proxy](https://github.com/stealth-bots/grok-bot-slack-events-proxy)

## Behavior

| Request | Response |
| --- | --- |
| `GET` | HTTP 200, short health string (`ok`). No secrets. |
| `POST` with `type: "url_verification"` and a `challenge` string | HTTP 200, `Content-Type: text/plain`, raw body = the challenge. **Not** forwarded to Cursor. |
| Any other Slack Events `POST` (`event_callback`, etc.) | Forwards the **raw body** as `POST` to `CURSOR_WEBHOOK_URL` with `Authorization: Bearer ${CURSOR_WEBHOOK_KEY}` and `Content-Type: application/json`. The key is never added to the URL. Returns HTTP 200 after a successful forward, or **502** if Cursor fails. |
| Optional `SLACK_SIGNING_SECRET` | When set, verifies `X-Slack-Signature` / `X-Slack-Request-Timestamp` before forwarding. When unset, challenge + forward still work so you can finish Slack setup first. |

The Slack Request URL is the production origin plus `/slack` (`/slack` rewrites to `api/slack.ts`). Linear is `/linear`.

On an `AgentSessionEvent`, `/linear` posts a `thought` agent activity back to Linear before
forwarding to Cursor. Linear marks a session unresponsive if no activity arrives within 10
seconds, and the Cursor run cannot write into the session itself. The token is minted on
demand with the `client_credentials` grant (enable it on the Linear app), cached in memory,
and re-fetched once on a 401 — app actor tokens last 30 days and have no refresh token. With
`LINEAR_CLIENT_ID` / `LINEAR_CLIENT_SECRET` unset the ack is skipped and the forward still runs.

`/linear/callback` (`api/linear-callback.ts`) is the OAuth redirect target for the Linear app install. Linear requires a
publicly accessible HTTPS, non-localhost redirect URI, so register
`https://grok-bot-proxies.alt-x.systems/linear/callback` on the app rather than a localhost URL. The route only reports
whether the install completed — it holds no secrets and exchanges nothing. The app actor token used to post agent
activities comes from the `client_credentials` grant, which does not use the returned `code`.

## Environment

Set these in the Vercel project (Settings → Environment Variables). **Do not commit them.**

| Name | Required | Where |
| --- | --- | --- |
| `CURSOR_WEBHOOK_URL` | yes | Destination. Example **shape** only: `https://api2.cursor.sh/automations/webhook/<uuid>` |
| `CURSOR_WEBHOOK_KEY` | yes (secret) | The `crsr_...` bearer token. Never hardcode. Never put it in the URL. |
| `SLACK_SIGNING_SECRET` | no (secret) | Slack app signing secret. Add it after Event Subscriptions are working. |
| `LINEAR_WEBHOOK_SECRET` | yes for `/linear` (secret) | Signing secret of the **installed** Linear app. |
| `LINEAR_CLIENT_ID` | for the agent ack | Client ID of the same Linear app. |
| `LINEAR_CLIENT_SECRET` | for the agent ack (secret) | Client secret. Rotating it revokes every app actor token. |

The handler never logs the bearer key, signing secret, or `Authorization` header.

## Deploy on Vercel

1. Connect [stealth-bots/grok-bot-slack-events-proxy](https://github.com/stealth-bots/grok-bot-slack-events-proxy) to a Vercel project (Import Git Repository).
2. Set `CURSOR_WEBHOOK_URL` and `CURSOR_WEBHOOK_KEY` as project environment variables. Optionally set `SLACK_SIGNING_SECRET` later.
3. Deploy (`main` → Production).
4. Copy the Vercel URL. Production is currently `https://grok-bot-slack-events-proxy.vercel.app`.

Or from a laptop already logged into Vercel:

```bash
npm install
npx vercel env add CURSOR_WEBHOOK_URL
npx vercel env add CURSOR_WEBHOOK_KEY
npx vercel --prod
```

## Slack Event Subscriptions

1. Turn **Socket Mode off**.
2. Event Subscriptions → Enable Events.
3. **Request URL:** paste the **Vercel URL with `/slack`**, for example `https://grok-bot-slack-events-proxy.vercel.app/slack`. Not the origin root, and not the Cursor webhook URL.
4. Subscribe to bot events:
   - `message.im`
   - `app_mention`
5. Save. Slack will POST `url_verification`; this endpoint echoes the challenge so the URL verifies.

## Local development

```bash
cp .env.example .env.local
# put your own values in .env.local — never commit that file
npm test
npx vercel dev --listen 43123
```

Slack needs a public HTTPS URL, so use a Vercel deploy for real Event Subscriptions.

## Tests

```bash
npm test
```

Covers challenge echo (no forward) and event forwards that send `Authorization: Bearer …` without putting the key in the URL.

## Optional: Cloudflare Worker

`src/index.ts` and `wrangler.toml` remain if you prefer Workers. Do not put secrets in git.

```bash
npx wrangler secret put CURSOR_WEBHOOK_URL
npx wrangler secret put CURSOR_WEBHOOK_KEY
npx wrangler deploy
```
