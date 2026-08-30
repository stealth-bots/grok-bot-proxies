const TEXT_PLAIN = 'text/plain; charset=utf-8';

// Served at `/`. Health lives on `/linear` and `/slack`, which answer `ok` — point
// monitoring at those, not here.
const PAGE = `grok-bot proxies

Public HTTPS hops between Slack, Linear and the Cursor webhooks that run grok-bot.

Endpoints
  /linear            Linear webhooks
  /linear/activity   agent activities
  /linear/comment    issue comments
  /linear/callback   OAuth redirect
  /slack             Slack events

Every endpoint is authenticated. Nothing here accepts unsigned input, and no
credential is ever echoed back or logged.

Source        https://github.com/stealth-bots/grok-bot-proxies
Built by      stealth factory   https://www.stealth-factory.co
Contributor   @wiiiimm          https://x.com/wiiiimm

MIT licensed.
`;

export function GET(): Response {
	return new Response(PAGE, { status: 200, headers: { 'content-type': TEXT_PLAIN } });
}

export function HEAD(): Response {
	return new Response(null, { status: 200, headers: { 'content-type': TEXT_PLAIN } });
}

export function POST(): Response {
	return new Response('Not Found', { status: 404, headers: { 'content-type': TEXT_PLAIN } });
}

export default {
	fetch(request: Request): Response {
		const method = request.method.toUpperCase();
		if (method === 'GET') {
			return GET();
		}
		if (method === 'HEAD') {
			return HEAD();
		}
		return POST();
	},
};
