# Slack

Slack talks to Grok Bot through `/slack`. **There is no outbound route** — see below.

Slack POSTs JSON to a Request URL and cannot send an `Authorization` header, while Cursor
webhooks require one and reject keys in the URL. Slack also requires a `url_verification`
challenge echo, which a Cursor webhook will never produce.

## Routes

| Route             | Handler        | Behaviour                                                                                                                                                                                  |
| ----------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET,HEAD /slack` | `api/slack.ts` | `ok` health string. No secrets.                                                                                                                                                            |
| `POST /slack`     | `api/slack.ts` | `url_verification` ⇒ echoes `challenge` as `text/plain`, never forwarded. Anything else ⇒ forwards the **raw body** to `CURSOR_WEBHOOK_URL` with a Bearer header. **502** if Cursor fails. |

`/api/webhooks/slack` is an alias of `/slack`.

Slack returns **502** on a Cursor failure so that Slack retries. This is deliberately unlike
Linear, which answers 200 regardless — see [Adding a service](adding-a-service.md).

## Setup

1. Socket Mode **off**.
2. Event Subscriptions → Enable Events.
3. Request URL: `https://grok-bot-proxies.alt-x.systems/slack` — not the origin root, and not
   the Cursor webhook URL.
4. Subscribe to bot events `message.im` and `app_mention`.
5. Save; Slack POSTs `url_verification` and this echoes the challenge.
6. Optionally set `SLACK_SIGNING_SECRET` afterwards to verify signatures. Leave it unset until
   Event Subscriptions verify, so setup is not blocked on it.

## Replying — no outbound route

Unlike Linear, the proxy does **not** relay replies to Slack. A run answers by calling Slack's
Web API itself with its own bot token:

```bash
curl -sS -X POST https://slack.com/api/chat.postMessage \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H 'Content-type: application/json; charset=utf-8' \
  --data '{"channel":"C0CHANNEL","thread_ts":"1699999999.000100","text":"…"}'
```

Two consequences, both covered by the `slack-agent-reply` skill:

- **The run needs Slack credentials.** The Linear path keeps credentials in the proxy; this one
  cannot, until an outbound route exists.
- **The loop guard lives in the run.** Slack delivers the bot's own messages back as events, and
  nothing here filters them, so a reply triggers another run which replies again. Drop events
  with `bot_id` set, or whose `user` is the bot's own id. The Linear equivalent is handled in
  the proxy by forwarding only `AgentSessionEvent`.

Adding `/slack/message`, shaped like `/linear/comment`, would close both gaps.

## Gotchas

- **Thread with `thread_ts = event.thread_ts ?? event.ts`.** Using `event.ts` on a message
  already in a thread starts a nested reply; omitting it posts to the channel and loses the
  conversation.
- **Slack answers HTTP 200 even on failure.** Check `"ok": true` in the body.
- **Slack retries** when it does not get a fast 200, marked with `X-Slack-Retry-Num`. The proxy
  answers immediately, so a retry usually means the proxy itself was unreachable. Treat a
  repeated `event.ts` as already handled.
- **Use Slack `mrkdwn`, not Markdown**: `*bold*`, `_italic_`, `<https://url|label>`.
