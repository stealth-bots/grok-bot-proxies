# Adding a service

Every service here follows the same shape. This is the checklist, and the decisions worth
making deliberately rather than by copying.

## The shape

1. **`api/<service>.ts`** — inbound webhook. Verify the signature, then forward the raw body to
   a runner webhook with `Authorization: Bearer`. Never put the key in the URL.
2. **`api/<service>-<write>.ts`** — outbound relay, if the runner needs to write back. Guard it
   with a shared bearer and **fail closed** when that secret is unset.
3. **`vercel.json`** — a rewrite per route, most specific first.
4. **`test/<service>.spec.ts`** — signature rejection, the forward, and the relay's auth.
5. **`docs/<service>.md`** — setup, replying, gotchas.
6. **`skills/<service>-agent-reply/SKILL.md`** — the spec the run reads.

Handlers are **self-contained**: no imports between `api/*.ts`. That is deliberate — an early
version imported a shared module and the deployed function 500'd with `ERR_MODULE_NOT_FOUND`.
Duplicating token minting is the cheaper trade.

## Decisions to make per service

**Does a failed forward return an error, or 200?**
Slack returns **502** so Slack retries. Linear returns **200** and forwards in the background,
because Linear times out at 5 seconds and its retries reuse the original signed timestamp — a
slow hop would become a retry storm of stale-timestamp 401s. Pick based on how the platform
retries, not on taste.

**Does the platform expect an acknowledgement?**
Linear marks an agent session unresponsive without an activity in 10 seconds, so the proxy
posts one immediately. Slack needs only the HTTP 200.

**Which events are worth forwarding?**
Forward the narrowest set the runner can act on. Forwarding everything Linear sent started
three runs per mention, two of which had no session to reply to — and made the agent's own
comments trigger fresh runs. If the platform echoes the bot's own activity back, filter it
here or the loop guard becomes every runner's problem.

**Who holds the credentials?**
Prefer the proxy. It keeps tokens out of runs, gives one place to log, and means a rotation is
one env change. Slack currently does not have an outbound route, so its runs need their own
token — that is a gap, not a design.

## Conventions

- Tabs, single quotes, `printWidth` 140 — `.prettierrc` and `.editorconfig` cover it.
- Log every leg, never a secret. Redact any URL that came from a secret env var.
- Treat a platform's HTTP 200 with an `errors` body as failure; check the payload, not the
  status.
- Cap logged bodies, and gate them behind `LOG_PAYLOADS`.

---

Built by [stealth factory](https://www.stealth-factory.co) · [@wiiiimm](https://x.com/wiiiimm)
