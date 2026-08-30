# Linear

Linear talks to Grok Bot through `/linear`, and Grok Bot talks back through `/linear/activity`
or `/linear/comment`.

Linear's agent protocol is not request/response. It signs a webhook, expects HTTP 200 inside 5
seconds, requires an _activity_ within 10, and expects the real reply to arrive later through
its GraphQL API. A webhook-triggered runner can satisfy none of that alone: it has no Linear
token, and by the time it finishes the request is long closed.

## Routes

| Route                   | Handler                  | Behaviour                                                                                                                                          |
| ----------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET,HEAD /linear`      | `api/linear.ts`          | `ok` health string.                                                                                                                                |
| `POST /linear`          | `api/linear.ts`          | Verifies `Linear-Signature`, acks the session, forwards `AgentSessionEvent` payloads to `LINEAR_CURSOR_WEBHOOK_URL`. Always **200** once verified. |
| `GET /linear/callback`  | `api/linear-callback.ts` | OAuth redirect landing. Holds no secrets, exchanges nothing.                                                                                       |
| `POST /linear/activity` | `api/linear-activity.ts` | Grok Bot posts session output; relayed as an agent activity.                                                                                       |
| `POST /linear/comment`  | `api/linear-comment.ts`  | Grok Bot leaves an ordinary issue comment. Does **not** touch session state.                                                                       |

`/api/webhooks/linear` is an alias of `/linear`.

`POST /linear` always answers 200 once the signature checks out, and forwards in the
background. Linear times out at 5 seconds and its retries reuse the original signed
`webhookTimestamp`, so a slow Cursor hop would become a retry storm of stale-timestamp 401s.
Cursor's reply is logged rather than surfaced.

## Setup

Order matters. Getting this wrong fails **silently** — see [Gotchas](#gotchas).

1. **Create an OAuth application.** Note its Client ID and Client Secret, and enable
   **client credentials tokens**.
2. **Webhook**: URL `https://grok-bot-proxies.alt-x.systems/linear`, and tick **Agent session
   events** (last in the category list). Copy the signing secret into `LINEAR_WEBHOOK_SECRET`.
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

   `app:mentionable` makes @mentions resolve; `app:assignable` allows delegation. Pick the
   teams the agent should see when prompted.

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

## Replying into a session

`POST /linear` writes two activities by itself: a `thought` ack inside Linear's 10 second
deadline, then — once Cursor answers — an `action` naming the run (`Sent to Grok Bot` and the
`runUuid`), so the handoff is visible in the thread. If Cursor refuses the handoff it posts an
`error` instead, which **closes** the session; a visibly failed session beats one spinning on a
run that never started.

**Neither closes a successful session** — the Grok Bot run sends the final activity itself.

```
POST https://grok-bot-proxies.alt-x.systems/linear/activity
Authorization: Bearer $LINEAR_ACTIVITY_SECRET
Content-Type: application/json

{ "agentSessionId": "<agentSession.id>", "type": "response", "body": "Markdown supported." }
```

| `type`        | Fields                                   | Session after       |
| ------------- | ---------------------------------------- | ------------------- |
| `thought`     | `body`                                   | still working       |
| `action`      | `action`, `parameter`, optional `result` | still working       |
| `elicitation` | `body`                                   | waiting on the user |
| `response`    | `body`                                   | **closed**          |
| `error`       | `body`                                   | **closed**, failed  |

`prompt` is user-generated and rejected. Send exactly one closing activity. Check the reply for
`"ok": true`; on `false`, `linear` holds the error.

`agentSession.id` is only on `AgentSessionEvent` payloads — a single mention fires several
events, and only that one is forwarded.

### Ordinary comments

For a reply that should read like a teammate rather than session output:

```
POST /linear/comment
Authorization: Bearer <LINEAR_ACTIVITY_SECRET>
Content-Type: application/json

{ "issueId": "<issue UUID>", "body": "Markdown supported.", "parentId": "<optional, to thread>" }
```

`issueId` is the issue **UUID**, not `GROK-1`; it is in every webhook payload at `data.issueId`
or `agentSession.issueId`. `parentId` threads under an existing comment.

A comment does **not** close an agent session. If one is open, comment _and_ close it, or the
spinner stays. Comments by the app return as `Comment` webhooks, but those are not forwarded,
so they cannot start a run.

### Pair with the Linear MCP

Read and search with Linear's official MCP server; write through this proxy. The MCP
authenticates as the user who connected it, so its writes are attributed to that person — the
proxy exists so replies come from Grok Bot. The `linear-agent-reply` skill says this too.

## Gotchas

Each of these cost real debugging time.

- **A failed install leaves the app with no permissions, and everything downstream goes quiet.**
  Linear generates no events, so it never _attempts_ a delivery, so no webhook failures are
  logged either. An empty delivery log means "nothing was generated", **not** "Linear is
  broken". Check the application's permission screen first.
- **Webhook config must live on the application that is actually installed.** Creating a
  replacement app orphans the old one's webhook and signing secret. The app user's email is
  `<applicationId>@oauthapp.linear.app` — that is how you tell which app backs an agent.
- **An app user's `teams: []` is not authoritative.** App actor tokens reach all _public_ teams
  regardless. Query as the app: `{ teams { nodes { id name key private } } }`.
- **Vercel invocation logs are decisive**, because a bad signature still _invokes_ the function
  and logs a 401. Silence in the log means Linear never called.
- **You cannot read webhook config via the API** — it returns "Invalid role: admin required",
  and `actor=app` integrations cannot request the `admin` scope at all.
- **One mention fires several Linear events** — `Comment`, `AppUserNotification` and
  `AgentSessionEvent` all arrive. Only the last carries a session id, so only it is forwarded.
  Forwarding the others started three runs per mention, two with nothing to reply to, and made
  the agent's own comments trigger fresh runs.
- **HTTP 200 from Linear's GraphQL API is not success.** A rejected activity shape returns 200
  with an `errors` array. Check for `"success":true`.
- **App actor tokens last 30 days with no refresh token.** Re-fetch on a 401. Requesting a token
  with a _different_ scope string revokes the existing ones.
