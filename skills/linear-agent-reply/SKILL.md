---
name: linear-agent-reply
description: Reply into Linear from an agent run via the grok-bot proxy — post agent-session activities (thought, action, elicitation, response, error) or an ordinary issue comment. Use when a run was triggered by a Linear webhook and needs to report progress, ask the user a question, deliver its final answer, close the session, or comment on an issue. Pair it with Linear's official MCP: read and search with the MCP, write through the proxy so the reply is attributed to the agent and not to whoever connected the MCP. Covers which of the two endpoints to use and why a session otherwise spins forever.
---

# Replying into Linear

Two endpoints on the bridge. Both take the same bearer, both write to Linear as the app user.

- `POST https://grok-bot-proxies.alt-x.systems/linear/activity` — agent-session output. **Drives session state.**
- `POST https://grok-bot-proxies.alt-x.systems/linear/comment` — an ordinary issue comment. **Does not touch session state.**

`https://grok-bot-proxies.alt-x.systems` is the bridge deployment. The bearer is its `LINEAR_ACTIVITY_SECRET`.

## Which to use

Was this run triggered by an `AgentSessionEvent` webhook?

- **Yes** → use `/linear/activity`. You **must** eventually send `response`, `elicitation`, or
  `error`. Without one the session spins forever, which reads to the user as a hang.
- **No**, or you want the reply to read like an ordinary teammate → use `/linear/comment`.

Both is legitimate: comment for the readable reply, then a short `response` activity to close
the session. Never leave an open session unclosed.

## POST /linear/activity

```http
POST https://grok-bot-proxies.alt-x.systems/linear/activity
Authorization: Bearer <LINEAR_ACTIVITY_SECRET>
Content-Type: application/json
```

```json
{ "agentSessionId": "<uuid>", "type": "response", "body": "Markdown supported." }
```

`agentSessionId` comes from the webhook payload at `agentSession.id`. Only
`AgentSessionEvent` payloads have one.

| `type`        | Required fields                          | Session after       |
| ------------- | ---------------------------------------- | ------------------- |
| `thought`     | `body`                                   | working             |
| `action`      | `action`, `parameter`, optional `result` | working             |
| `elicitation` | `body`                                   | waiting on the user |
| `response`    | `body`                                   | **closed**          |
| `error`       | `body`                                   | **closed**, failed  |

`prompt` is user-generated and is rejected. Shapes are validated server-side.

An `action` describes a tool call: `{"type":"action","action":"Searched","parameter":"weather","result":"12C"}`.
Omit `result` to show it as still running.

## POST /linear/comment

```json
{ "issueId": "<issue uuid>", "body": "Markdown supported.", "parentId": "<optional>" }
```

`issueId` is the issue **UUID**, not `ABC-123`. It is in every webhook payload at
`data.issueId` or `agentSession.issueId`. `parentId` threads the comment under an existing
one — use the comment id you are replying to.

## Pair this with the Linear MCP

Use Linear's official MCP server for everything the proxy does not do: reading issues,
comments, projects and documents, searching, and updating fields like status, assignee or
labels. It exposes the full API; the proxy exposes only the two writes an agent needs.

The split matters because of **authorship**. The MCP authenticates as the _user_ who connected
it, so anything it writes shows up as that person. The bridge authenticates as the _app_, so
comments and activities show up as Grok Bot. So:

- **Read and search with the MCP** — issue bodies, comment history, related issues, project
  context, whatever you need to answer well.
- **Write through the proxy** — so the reply is attributed to the agent rather than to
  whoever connected the MCP.

Gathering context with the MCP and then replying through the proxy is the intended shape.

## Responses

Both return `{ "ok": boolean, "linearStatus": number, "linear": <Linear's reply> }`.

**Check `ok`, not the HTTP status.** Linear's GraphQL API answers HTTP 200 with an `errors`
array when it rejects an input, so a 200 does not mean the write happened. On `ok: false`,
`linear` holds the reason.

| Status | Meaning                                   |
| ------ | ----------------------------------------- |
| 200    | written                                   |
| 400    | malformed body — `error` says which field |
| 401    | wrong or missing bearer                   |
| 502    | Linear rejected it; read `linear`         |
| 503    | the bridge is missing credentials         |

## Rules

- Send exactly one closing activity per session.
- For mentions inside any `body`, paste plain Linear URLs — they render as mentions. Do not
  write `@name`; it stays literal text.
- Markdown works in every `body`.
- Long jobs: send a `thought` or `action` as you go so the session shows progress, then one
  `response` at the end.
