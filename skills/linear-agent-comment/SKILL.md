---
name: linear-agent-comment
description: Leave an ordinary comment on a Linear issue as Grok Bot, through the proxy at /linear/comment, optionally threaded under an existing comment. Use when the reply should read like a teammate rather than agent-session output, or when the run was not triggered by an agent session. Does NOT close an agent session — if one is open, use linear-agent-activity as well or the spinner never stops.
---

# Leaving an issue comment

```http
POST https://grok-bot-proxies.alt-x.systems/linear/comment
Authorization: Bearer <LINEAR_ACTIVITY_SECRET>
Content-Type: application/json
```

```json
{ "issueId": "<issue uuid>", "body": "Markdown supported.", "parentId": "<optional>" }
```

| Field      | Required | Notes                                                                                                   |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `issueId`  | yes      | The issue **UUID**, not `GROK-4`. In every webhook payload at `data.issueId` or `agentSession.issueId`. |
| `body`     | yes      | Markdown supported.                                                                                     |
| `parentId` | no       | Comment id to thread under. Omit for a top-level comment.                                               |

The comment is authored by Grok Bot, so it appears as the agent rather than as a person.

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

## When not to use this

A comment **does not close an agent session**. If your run came from an `AgentSessionEvent`,
commenting alone leaves the session spinning and the user sees a hang next to your reply.
Either use `linear-agent-activity` instead, or comment _and_ send a short `response` activity
to close the session.

## Rules

- For mentions inside `body`, paste plain Linear URLs — they render as mentions. Do not write
  `@name`; it stays literal text.
- Your comment comes back to the proxy as a `Comment` webhook. Those are not forwarded, so
  commenting cannot trigger another run — do not add your own loop guard.

## Response

```json
{ "ok": true, "linearStatus": 200, "linear": { "data": { "commentCreate": { "success": true, "comment": { "id": "…", "url": "…" } } } } }
```

**Check `ok`, not the HTTP status.** Linear answers HTTP 200 with an `errors` array when it
rejects an input. On `ok: false`, `linear` holds the reason.

| Status | Meaning                                  |
| ------ | ---------------------------------------- |
| 400    | malformed body — `error` names the field |
| 401    | wrong or missing bearer                  |
| 502    | Linear rejected it; read `linear`        |
| 503    | the proxy is missing credentials         |
