# Operations

Shared across every service: environment, deploying, logging, local development, tests.

## Environment

Set in the Vercel project (Settings → Environment Variables). **Never commit them.**
A Vercel env change only applies to deployments created _after_ it — **redeploy**.

| Name                        | Service                  | Notes                                                                                               |
| --------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------- |
| `CURSOR_WEBHOOK_URL`        | Slack                    | Shape only: `https://api2.cursor.sh/automations/webhook/<uuid>`                                     |
| `CURSOR_WEBHOOK_KEY`        | Slack (secret)           | `crsr_…` bearer. Never in the URL.                                                                  |
| `SLACK_SIGNING_SECRET`      | Slack (optional, secret) | When set, verifies signature + 5 min skew.                                                          |
| `LINEAR_CURSOR_WEBHOOK_URL` | Linear                   | A **different** Cursor routine from Slack's.                                                        |
| `LINEAR_CURSOR_WEBHOOK_KEY` | Linear (secret)          | `crsr_…` bearer.                                                                                    |
| `LINEAR_WEBHOOK_SECRET`     | Linear (secret)          | Signing secret of the **installed** Linear app. Unset ⇒ `POST /linear` returns 503.                 |
| `LINEAR_CLIENT_ID`          | Linear                   | Client ID of that same app.                                                                         |
| `LINEAR_CLIENT_SECRET`      | Linear (secret)          | Rotating it revokes **every** app actor token.                                                      |
| `LINEAR_ACTIVITY_SECRET`    | Linear (secret)          | Shared bearer Grok Bot sends to `/linear/activity` and `/linear/comment`. Unset ⇒ both 503.         |
| `LOG_PAYLOADS`              | all                      | Request bodies are **not** logged unless this is `1`. Token-shaped strings are redacted regardless. |

The handlers never log a bearer key, signing secret, `Authorization` header, or a Cursor
destination URL.

## Deploying

`main` → production on Vercel.

```bash
npx vercel --prod
```

Remember that env changes need a redeploy to take effect.

## Health checks

`/` serves a landing page naming the project and linking its source — it is not a health
endpoint. Point monitoring at `/linear` and `/slack`, which answer `ok` as plain text and
touch no credentials.

## Logging

Every leg is logged. Request bodies are **not** included unless `LOG_PAYLOADS=1`, since they
carry issue and comment text and logs are retained; when opted in they are capped at 4 KB.
Anything token-shaped — `lin_oauth_…`, `crsr_…`, `xox…`, a `Bearer` header — is replaced with
`<redacted>` in every log line, bodies and relayed replies alike.

```
linear webhook: type=AgentSessionEvent action=created session=<uuid> bytes=…
agent activity -> session=<uuid> content={"type":"thought",…}
agent activity: session=<uuid> type=thought status=200 reply={…"success":true}
cursor forward: status=200 reply={"success":true,"runUuid":"…"}
activity request: session=<uuid> type=response
activity rejected: 401 bad or missing bearer
```

Turn payloads off again once an integration is settled.

**Invocation logs are the decisive diagnostic.** A bad signature still _invokes_ the function
and logs a 401, so silence in the log means the platform never called.

## Local development

```bash
npm install
cp .env.example .env.local   # your own values; never commit
npm test
npx vercel dev --listen 43123
```

Every platform needs public HTTPS, so use a deploy for real webhooks.

## Tests

```bash
npm test
```

Covers the Slack challenge echo and forward, Linear signature verification and retry-window
handling, the agent-session ack and its token refresh, session-only forwarding, the activity
and comment relays and their auth, and the OAuth callback.

---

Built by [stealth factory](https://www.stealth-factory.co) · [@wiiiimm](https://x.com/wiiiimm)
