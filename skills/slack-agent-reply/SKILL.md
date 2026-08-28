---
name: slack-agent-reply
description: Handle a Slack message that reached this run through the grok-bot proxy at /slack, and reply to it with Slack's Web API. Use when a run was triggered by a Slack app_mention or direct message and needs to answer in the right channel or thread. Covers the payload shape, threading, retry handling, and how to avoid replying to itself. Unlike the Linear path there is no outbound proxy route, so the run needs its own Slack bot token.
---

# Replying in Slack

The proxy forwards Slack Events API payloads to this run and answers Slack itself. **It does
not relay replies.** To answer, call Slack's Web API directly with a bot token
(`SLACK_BOT_TOKEN`, scope `chat:write`).

This differs from Linear, where the proxy holds the credentials and relays writes for you.

## What arrives

The body is the raw Slack event envelope. The parts that matter:

```json
{
	"type": "event_callback",
	"event": {
		"type": "app_mention",
		"text": "<@U123> can you look at this",
		"user": "U0HUMAN",
		"channel": "C0CHANNEL",
		"ts": "1699999999.000100",
		"thread_ts": "1699999998.000100",
		"bot_id": null
	}
}
```

| Field             | Use                                       |
| ----------------- | ----------------------------------------- |
| `event.channel`   | where to reply                            |
| `event.ts`        | this message's id                         |
| `event.thread_ts` | present only if it is already in a thread |
| `event.user`      | who asked                                 |
| `event.text`      | the message, with the mention as `<@U…>`  |
| `event.bot_id`    | present when a bot sent it — see below    |

Subscribed types are `app_mention` and `message.im`.

## Replying

```bash
curl -sS -X POST https://slack.com/api/chat.postMessage \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H 'Content-type: application/json; charset=utf-8' \
  --data '{"channel":"C0CHANNEL","thread_ts":"1699999999.000100","text":"…"}'
```

**Thread with `thread_ts = event.thread_ts ?? event.ts`.** Using `event.ts` when the message is
already in a thread starts a nested reply; omitting it entirely posts to the channel and loses
the conversation.

Slack answers HTTP 200 even on failure. **Check `"ok": true`** in the body; on false, `error`
names the cause (`channel_not_found`, `not_in_channel`, `invalid_auth`).

Use Slack `mrkdwn`, not Markdown: `*bold*`, `_italic_`, `` `code` ``, `<https://url|label>`.
Mention people as `<@U0HUMAN>`.

## Do not reply to yourself

Slack delivers your own bot's messages back as events. **Ignore any event with `bot_id` set,
or whose `user` is your own bot user id.** Without that check, answering in a channel triggers
another run, which answers again — a loop that costs a run per message and will not stop on
its own.

The Linear path is guarded in the proxy; this one is not, so the check belongs in the run.

## Retries

Slack retries when it does not get a fast 200, marking retries with an `X-Slack-Retry-Num`
header and `X-Slack-Retry-Reason`. The proxy answers Slack immediately, so a retry usually
means the proxy itself was unreachable. Treat a repeated `event.ts` as already handled rather
than answering twice.

## Reading Slack

For anything beyond replying — channel history, user profiles, searching — use a Slack MCP
server if one is connected, rather than hand-rolling Web API calls. Reserve the direct
`chat.postMessage` call for the reply itself.
