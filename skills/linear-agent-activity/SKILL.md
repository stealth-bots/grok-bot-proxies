---
name: linear-agent-activity
description: Post an agent-session activity into Linear as Grok Bot — thought, action, elicitation, response or error — through the proxy at /linear/activity. Use when a run was triggered by an AgentSessionEvent webhook and needs to report progress, ask the user a question, deliver its final answer, or fail visibly. Required to close a session; without it the session spins forever. For an ordinary issue comment that does not touch session state, use linear-agent-comment instead.
---

# Posting an agent activity

```http
POST https://grok-bot-proxies.alt-x.systems/linear/activity
Authorization: Bearer <LINEAR_ACTIVITY_SECRET>
Content-Type: application/json
```

```json
{ "agentSessionId": "<uuid>", "type": "response", "body": "Markdown supported." }
```

`agentSessionId` comes from the webhook payload at `agentSession.id`. Only `AgentSessionEvent`
payloads carry one — the proxy forwards nothing else, so if you were triggered, you have it.

## Types

| `type`        | Required fields                          | Session after       |
| ------------- | ---------------------------------------- | ------------------- |
| `thought`     | `body`                                   | working             |
| `action`      | `action`, `parameter`, optional `result` | working             |
| `elicitation` | `body`                                   | waiting on the user |
| `response`    | `body`                                   | **closed**          |
| `error`       | `body`                                   | **closed**, failed  |

`prompt` is user-generated and is rejected. Shapes are validated server-side.

An `action` describes a tool call:

```json
{ "type": "action", "action": "Searched", "parameter": "GROK-4 history", "result": "3 comments" }
```

Omit `result` to show it as still running.

## Rules

- **Send exactly one closing activity** (`response`, `elicitation` or `error`) per session.
  The proxy already posted a `thought` and an `action` before you started; neither closes it,
  so a session with no closing activity spins forever and reads as a hang.
- The proxy's ack tells the user a reply takes 5–10 minutes. Send a `thought` or `action` if
  you run much longer than that.
- For mentions inside a `body`, paste plain Linear URLs — they render as mentions. Do not
  write `@name`; it stays literal text.

## Pair this with the Linear MCP

Use Linear's official MCP server for everything this proxy does not do: reading issues,
comments, projects and documents, searching, and updating fields like status, assignee or
labels. It exposes the full API; this proxy exposes only the writes an agent needs.

The split matters because of **authorship**. The MCP authenticates as the _user_ who connected
it, so anything it writes shows up as that person. This proxy authenticates as the _app_, so
comments and activities show up as Grok Bot. So:

- **Read and search with the MCP** — issue bodies, comment history, related issues, project
  context, whatever you need to answer well.
- **Write through the proxy** — so the reply is attributed to Grok Bot rather than to whoever
  connected the MCP.

Gathering context with the MCP and then replying through the proxy is the intended shape.

## Response

```json
{ "ok": true, "linearStatus": 200, "linear": { "data": { "agentActivityCreate": { "success": true } } } }
```

**Check `ok`, not the HTTP status.** Linear answers HTTP 200 with an `errors` array when it
rejects an input. On `ok: false`, `linear` holds the reason.

| Status | Meaning                                  |
| ------ | ---------------------------------------- |
| 400    | malformed body — `error` names the field |
| 401    | wrong or missing bearer                  |
| 502    | Linear rejected it; read `linear`        |
| 503    | the proxy is missing credentials         |
