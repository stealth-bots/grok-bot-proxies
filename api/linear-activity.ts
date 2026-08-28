// Outbound hop: the Cursor run posts its reply here and this relays it to Linear as
// an agent activity. Keeps the Linear app credentials in one place — the Cursor side
// never needs them. Self-contained on purpose; see api/linear.ts.

const TEXT_PLAIN = 'text/plain; charset=utf-8';
const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';
const LINEAR_TOKEN_URL = 'https://api.linear.app/oauth/token';
// Changing this scope string revokes every existing app actor token for the app.
const APP_TOKEN_SCOPES = 'read,write,app:assignable,app:mentionable';
const TOKEN_EXPIRY_MARGIN_MS = 60 * 1000;
const MAX_LOGGED_REPLY = 500;

// `prompt` is deliberately absent: that type is user-generated and an agent cannot emit it.
const BODY_TYPES = new Set(['thought', 'elicitation', 'response', 'error']);
const ACTIVITY_TYPES = new Set([...BODY_TYPES, 'action']);

let cachedAppToken: { value: string; expiresAt: number } | null = null;

export function resetAppTokenCache(): void {
	cachedAppToken = null;
}

export interface LinearActivityEnv {
	LINEAR_CLIENT_ID?: string;
	LINEAR_CLIENT_SECRET?: string;
	LINEAR_ACTIVITY_SECRET?: string;
}

function envFromProcess(): LinearActivityEnv {
	return {
		LINEAR_CLIENT_ID: process.env.LINEAR_CLIENT_ID,
		LINEAR_CLIENT_SECRET: process.env.LINEAR_CLIENT_SECRET,
		LINEAR_ACTIVITY_SECRET: process.env.LINEAR_ACTIVITY_SECRET,
	};
}

export function GET(request: Request): Promise<Response> {
	return handleLinearActivityRequest(request, envFromProcess());
}

export function HEAD(request: Request): Promise<Response> {
	return handleLinearActivityRequest(request, envFromProcess());
}

export function POST(request: Request): Promise<Response> {
	return handleLinearActivityRequest(request, envFromProcess());
}

export default {
	fetch(request: Request): Promise<Response> {
		return handleLinearActivityRequest(request, envFromProcess());
	},
};

export async function handleLinearActivityRequest(request: Request, env: LinearActivityEnv): Promise<Response> {
	const method = request.method.toUpperCase();

	if (method === 'GET' || method === 'HEAD') {
		return new Response(method === 'HEAD' ? null : 'ok', {
			status: 200,
			headers: { 'content-type': TEXT_PLAIN },
		});
	}

	if (method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD, POST' } });
	}

	const callerSecret = env.LINEAR_ACTIVITY_SECRET?.trim();
	if (!callerSecret) {
		// Fail closed: without a shared secret this route would let anyone write into the workspace.
		return new Response('LINEAR_ACTIVITY_SECRET is not configured', { status: 503 });
	}
	if (!bearerMatches(request.headers.get('authorization'), callerSecret)) {
		return new Response('Unauthorized', { status: 401 });
	}

	const content = contentFrom(await request.text());
	if ('error' in content) {
		return json({ ok: false, error: content.error }, 400);
	}

	let token = await appActorToken(env);
	if (!token) {
		return json({ ok: false, error: 'LINEAR_CLIENT_ID/LINEAR_CLIENT_SECRET not configured' }, 503);
	}

	let response = await postActivity(token, content.agentSessionId, content.content);
	if (response.status === 401) {
		// App actor tokens carry no refresh token; the documented recovery is a fresh one.
		cachedAppToken = null;
		token = await fetchAppActorToken(env);
		if (token) {
			response = await postActivity(token, content.agentSessionId, content.content);
		}
	}

	const reply = await response.text();
	console.log(`agent activity (${content.content.type}): status=${response.status} reply=${reply.slice(0, MAX_LOGGED_REPLY)}`);

	// Linear answers 200 with an `errors` array on a rejected shape, so status alone is not success.
	const succeeded = response.ok && reply.includes('"success":true');
	return json({ ok: succeeded, linearStatus: response.status, linear: safeJson(reply) }, succeeded ? 200 : 502);
}

type ActivityContent = Record<string, unknown> & { type: string };

function contentFrom(rawBody: string): { agentSessionId: string; content: ActivityContent } | { error: string } {
	let payload: unknown;
	try {
		payload = rawBody ? JSON.parse(rawBody) : null;
	} catch {
		return { error: 'body must be JSON' };
	}

	if (!isRecord(payload)) {
		return { error: 'body must be a JSON object' };
	}

	const agentSessionId = payload.agentSessionId;
	if (typeof agentSessionId !== 'string' || !agentSessionId) {
		return { error: 'agentSessionId is required' };
	}

	const type = payload.type;
	if (typeof type !== 'string' || !ACTIVITY_TYPES.has(type)) {
		return { error: `type must be one of ${[...ACTIVITY_TYPES].join(', ')}` };
	}

	if (type === 'action') {
		const action = payload.action;
		const parameter = payload.parameter;
		if (typeof action !== 'string' || typeof parameter !== 'string') {
			return { error: 'action activities require string action and parameter' };
		}
		const content: ActivityContent = { type, action, parameter };
		if (typeof payload.result === 'string') {
			content.result = payload.result;
		}
		return { agentSessionId, content };
	}

	const body = payload.body;
	if (typeof body !== 'string' || !body) {
		return { error: `${type} activities require a non-empty body` };
	}

	return { agentSessionId, content: { type, body } };
}

function postActivity(token: string, agentSessionId: string, content: ActivityContent): Promise<Response> {
	return fetch(LINEAR_GRAPHQL_URL, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			query: 'mutation AgentActivityCreate($input: AgentActivityCreateInput!) { agentActivityCreate(input: $input) { success } }',
			variables: { input: { agentSessionId, content } },
		}),
	});
}

async function appActorToken(env: LinearActivityEnv): Promise<string | null> {
	if (cachedAppToken && cachedAppToken.expiresAt > Date.now()) {
		return cachedAppToken.value;
	}

	return fetchAppActorToken(env);
}

async function fetchAppActorToken(env: LinearActivityEnv): Promise<string | null> {
	const clientId = env.LINEAR_CLIENT_ID?.trim();
	const clientSecret = env.LINEAR_CLIENT_SECRET?.trim();
	if (!clientId || !clientSecret) {
		return null;
	}

	const response = await fetch(LINEAR_TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'client_credentials',
			scope: APP_TOKEN_SCOPES,
			client_id: clientId,
			client_secret: clientSecret,
		}).toString(),
	});

	if (!response.ok) {
		// Never log the body: it echoes back credentials on some error shapes.
		console.log(`linear token fetch failed: status=${response.status}`);
		return null;
	}

	const payload = (await response.json()) as { access_token?: string; expires_in?: number };
	if (typeof payload.access_token !== 'string') {
		return null;
	}

	cachedAppToken = { value: payload.access_token, expiresAt: Date.now() + (payload.expires_in ?? 0) * 1000 - TOKEN_EXPIRY_MARGIN_MS };
	return payload.access_token;
}

function bearerMatches(header: string | null, expected: string): boolean {
	if (!header) {
		return false;
	}
	const match = /^Bearer\s+(.+)$/i.exec(header.trim());
	return match ? timingSafeEqual(match[1], expected) : false;
}

function json(payload: unknown, status: number): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8' },
	});
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text.slice(0, MAX_LOGGED_REPLY);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function timingSafeEqual(left: string, right: string): boolean {
	const encoder = new TextEncoder();
	const leftBytes = encoder.encode(left);
	const rightBytes = encoder.encode(right);
	if (leftBytes.length !== rightBytes.length) {
		return false;
	}

	let mismatch = 0;
	for (let i = 0; i < leftBytes.length; i++) {
		mismatch |= leftBytes[i] ^ rightBytes[i];
	}
	return mismatch === 0;
}
