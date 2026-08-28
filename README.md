# grok-bot proxies

Public HTTPS hops between **Slack** / **Linear** and the Cursor Grok Bot webhooks, plus the
outbound hop that lets a Grok Bot run reply into a Linear agent session.

Neither platform can talk to Cursor directly. Slack cannot send an `Authorization` header and
requires a `url_verification` challenge echo, which a Cursor webhook will never do. Linear
signs its deliveries, expects a 200 inside 5 seconds, and — for agents — expects replies to
arrive out-of-band through its GraphQL API rather than in the webhook response.

Production: `https://grok-bot-proxies.alt-x.systems`
Repo: [stealth-bots/grok-bot-proxies](https://github.com/stealth-bots/grok-bot-proxies)

Deployed on **Vercel** (`main` → production). A Cloudflare Worker remains in the tree; you do
not need both.

## Routes

| Route                   | Handler                  | Behaviour                                                                                                                                                                                  |
| ----------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /`                 | `api/index.ts`           | `ok`. `POST /` is 404.                                                                                                                                                                     |
| `GET,HEAD /slack`       | `api/slack.ts`           | `ok` health string. No secrets.                                                                                                                                                            |
| `POST /slack`           | `api/slack.ts`           | `url_verification` ⇒ echoes `challenge` as `text/plain`, never forwarded. Anything else ⇒ forwards the **raw body** to `CURSOR_WEBHOOK_URL` with a Bearer header. **502** if Cursor fails. |
| `GET,HEAD /linear`      | `api/linear.ts`          | `ok` health string.                                                                                                                                                                        |
| `POST /linear`          | `api/linear.ts`          | Verifies `Linear-Signature`, acks agent sessions, forwards `AgentSessionEvent` payloads to `LINEAR_CURSOR_WEBHOOK_URL`. Always **200** once verified.                                      |
| `GET /linear/callback`  | `api/linear-callback.ts` | OAuth redirect landing for the app install. Holds no secrets, exchanges nothing.                                                                                                           |
| `POST /linear/activity` | `api/linear-activity.ts` | Grok Bot posts its reply here; relayed to Linear as an agent activity.                                                                                                                     |

`/api/webhooks/slack` and `/api/webhooks/linear` are aliases of `/slack` and `/linear`.

### Slack vs Linear error handling

They differ deliberately. Slack returns **502** when Cursor fails, so Slack retries. Linear
returns **200** regardless and forwards in the background — Linear times out at 5 seconds and
its retries reuse the original signed `webhookTimestamp`, so a slow Cursor hop would turn into
a retry storm of stale-timestamp 401s. Cursor's reply is logged instead of surfaced.

## Environment

Set in the Vercel project (Settings → Environment Variables). **Never commit them.**
A Vercel env change only applies to deployments created _after_ it — **redeploy**.

| Name                        | Needed for                          | Notes                                                                               |
| --------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------- |
| `CURSOR_WEBHOOK_URL`        | `/slack`                            | Shape only: `https://api2.cursor.sh/automations/webhook/<uuid>`                     |
| `CURSOR_WEBHOOK_KEY`        | `/slack` (secret)                   | `crsr_…` bearer. Never in the URL.                                                  |
| `SLACK_SIGNING_SECRET`      | `/slack` (optional, secret)         | When set, verifies signature + 5 min skew. Add it once Slack is working.            |
| `LINEAR_CURSOR_WEBHOOK_URL` | `/linear`                           | A **different** Cursor routine from Slack's.                                        |
| `LINEAR_CURSOR_WEBHOOK_KEY` | `/linear` (secret)                  | `crsr_…` bearer.                                                                    |
| `LINEAR_WEBHOOK_SECRET`     | `/linear` (secret)                  | Signing secret of the **installed** Linear app. Unset ⇒ `POST /linear` returns 503. |
| `LINEAR_CLIENT_ID`          | agent ack + activity relay          | Client ID of that same app.                                                         |
| `LINEAR_CLIENT_SECRET`      | agent ack + activity relay (secret) | Rotating it revokes **every** app actor token.                                      |
| `LINEAR_ACTIVITY_SECRET`    | `/linear/activity` (secret)         | Shared bearer Grok Bot sends. Unset ⇒ the route 503s.                               |

The handlers never log a bearer key, signing secret, `Authorization` header, or the Cursor
destination URL.

## Linear setup

Order matters. Getting this wrong fails **silently** — see Gotchas.

1. **Create an OAuth application.** Note its Client ID and Client Secret, and enable
   **client credentials tokens**.
2. **Webhook**: URL `https://grok-bot-proxies.alt-x.systems/linear`, and tick
   **Agent session events** (it is last in the category list). Copy the signing secret into
   `LINEAR_WEBHOOK_SECRET`.
3. **Redirect URI**: `https://grok-bot-proxies.alt-x.systems/linear/callback`. Linear requires
   a publicly accessible **HTTPS, non-localhost** URL, so localhost will not do.
4. **Install it** as a workspace admin — `actor=app` installs require admin:

   ```
   https://linear.app/oauth/authorize
     ?client_id=<CLIENT_ID>
     &redirect_uri=https%3A%2F%2Fgrok-bot-proxies.alt-x.systems%2Flinear%2Fcallback
     &response_type=code
     &actor=app
     &scope=read+write+app%3Aassignable+app%3Amentionable
   ```

   `app:mentionable` is what makes @mentions resolve; `app:assignable` allows delegation.
   Pick the teams you want the agent to see when prompted.

5. **Confirm the install is real** by minting a token. This also surfaces the app under
   Settings → Applications:

   ```bash
   curl -sS -X POST https://api.linear.app/oauth/token \
     -d grant_type=client_credentials \
     -d 'scope=read,write,app:assignable,app:mentionable' \
     -d client_id=<CLIENT_ID> -d client_secret=<CLIENT_SECRET>
   ```

   The returned `scope` must list all four. `"Client does not support the client_credentials
grant type"` means step 1's toggle is off.

6. Set `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_ACTIVITY_SECRET`, and redeploy.

## Grok Bot: replying into a session

`POST /linear` writes two activities into the session by itself: a `thought` ack inside
Linear's 10 second deadline, then — once Cursor answers — an `action` naming the run
(`Sent to Grok Bot` / the `runUuid`), so the handoff is visible in the thread. If Cursor
refuses the handoff it posts an `error` instead, which **closes** the session; better a
visibly failed session than one spinning on a run that never started.

**Neither of those closes a successful session** — the Grok Bot run has to send the final
activity itself.

Give the Cursor run these instructions:

> The webhook body with `type: "AgentSessionEvent"` carries your session at `agentSession.id`.
> Only that event type has one — a single mention fires several events. When done:
>
> ```
> POST https://grok-bot-proxies.alt-x.systems/linear/activity
> Authorization: Bearer $LINEAR_ACTIVITY_SECRET
> Content-Type: application/json
>
> { "agentSessionId": "<agentSession.id>", "type": "response", "body": "Markdown supported." }
> ```
>
> Check the reply for `"ok": true`; on `false`, `linear` holds the error.
> For mentions, paste plain Linear URLs — they render as mentions. Do not write `@name`.

| `type`        | Fields                                   | Session after       |
| ------------- | ---------------------------------------- | ------------------- |
| `thought`     | `body`                                   | still working       |
| `action`      | `action`, `parameter`, optional `result` | still working       |
| `elicitation` | `body`                                   | waiting on the user |
| `response`    | `body`                                   | **closed**          |
| `error`       | `body`                                   | **closed**, failed  |

`prompt` is user-generated and rejected. Send exactly one closing activity.

## Slack setup

1. Socket Mode **off**.
2. Event Subscriptions → Enable Events.
3. Request URL: `https://grok-bot-proxies.alt-x.systems/slack` — not the origin root, not the
   Cursor webhook URL.
4. Subscribe to bot events `message.im` and `app_mention`.
5. Save; Slack POSTs `url_verification` and this echoes the challenge.

## Gotchas

Each of these cost real debugging time.

- **A failed install leaves the app with no permissions, and everything downstream goes
  quiet.** Linear generates no events, so it never _attempts_ a delivery, so no webhook
  failures are logged either. An empty delivery log means "nothing was generated", **not**
  "Linear is broken". Check the application's permission screen first.
- **Webhook config must live on the application that is actually installed.** Creating a
  replacement app orphans the old one's webhook and signing secret. The app user's email is
  `<applicationId>@oauthapp.linear.app` — that is how you tell which app backs an agent.
- **An app user's `teams: []` is not authoritative.** App actor tokens reach all _public_
  teams regardless. Query as the app to find the truth:
  `{ teams { nodes { id name key private } } }`.
- **Vercel invocation logs are decisive**, because a bad signature still _invokes_ the
  function and logs a 401. Silence in the log means Linear never called.
- **You cannot read webhook config via the API** — it returns "Invalid role: admin required",
  and `actor=app` integrations cannot request the `admin` scope at all.
- **One mention fires several Linear events** — `Comment`, `AppUserNotification` and
  `AgentSessionEvent` all arrive. Only the last carries a session id, so only it is
  forwarded. Forwarding the others started three runs per mention, two with nothing to
  reply to, and made the agent's own comments trigger fresh runs.
- **HTTP 200 from Linear's GraphQL API is not success.** A rejected activity shape returns 200
  with an `errors` array. Check for `"success":true`.
- **App actor tokens last 30 days with no refresh token.** Re-fetch on a 401. Requesting a
  token with a _different_ scope string revokes the existing ones.

## Local development

```bash
npm install
cp .env.example .env.local   # your own values; never commit
npm test
npx vercel dev --listen 43123
```

Both platforms need public HTTPS, so use a deploy for real webhooks.

## Tests

```bash
npm test
```

Covers the Slack challenge echo and forward, Linear signature verification and retry-window
handling, the agent-session ack and its token refresh, the activity relay and its auth, and
the OAuth callback.

## Optional: Cloudflare Worker

`src/index.ts` and `wrangler.toml` remain if you prefer Workers.

```bash
npx wrangler secret put CURSOR_WEBHOOK_URL
npx wrangler secret put CURSOR_WEBHOOK_KEY
npx wrangler deploy
```
