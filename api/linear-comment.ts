// Outbound hop for ordinary issue comments, as opposed to agent-session activities.
// A comment reads like a normal teammate reply and is not tied to a session; it does
// NOT close one. Self-contained on purpose; see api/linear.ts.

const TEXT_PLAIN = 'text/plain; charset=utf-8';
const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';
const LINEAR_TOKEN_URL = 'https://api.linear.app/oauth/token';
// Changing this scope string revokes every existing app actor token for the app.
const APP_TOKEN_SCOPES = 'read,write,app:assignable,app:mentionable';
const TOKEN_EXPIRY_MARGIN_MS = 60 * 1000;
const MAX_LOGGED_REPLY = 500;
const MAX_LOGGED_BODY = 4000;

let cachedAppToken: { value: string; expiresAt: number } | null = null;

export function resetAppTokenCache(): void {
	cachedAppToken = null;
}

export interface LinearCommentEnv {
	LINEAR_CLIENT_ID?: string;
	LINEAR_CLIENT_SECRET?: string;
	LINEAR_ACTIVITY_SECRET?: string;
	LOG_PAYLOADS?: string;
}

function envFromProcess(): LinearCommentEnv {
	return {
		LINEAR_CLIENT_ID: process.env.LINEAR_CLIENT_ID,
		LINEAR_CLIENT_SECRET: process.env.LINEAR_CLIENT_SECRET,
		LINEAR_ACTIVITY_SECRET: process.env.LINEAR_ACTIVITY_SECRET,
		LOG_PAYLOADS: process.env.LOG_PAYLOADS,
	};
}

export function GET(request: Request): Promise<Response> {
	return handleLinearCommentRequest(request, envFromProcess());
}

export function HEAD(request: Request): Promise<Response> {
	return handleLinearCommentRequest(request, envFromProcess());
}

export function POST(request: Request): Promise<Response> {
	return handleLinearCommentRequest(request, envFromProcess());
}

export default {
	fetch(request: Request): Promise<Response> {
		return handleLinearCommentRequest(request, envFromProcess());
	},
};

export async function handleLinearCommentRequest(request: Request, env: LinearCommentEnv): Promise<Response> {
	const method = request.method.toUpperCase();

	if (method === 'GET' || method === 'HEAD') {
		return new Response(method === 'HEAD' ? null : 'ok', { status: 200, headers: { 'content-type': TEXT_PLAIN } });
	}

	if (method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD, POST' } });
	}

	const callerSecret = env.LINEAR_ACTIVITY_SECRET?.trim();
	if (!callerSecret) {
		// Fail closed: this route comments into the workspace as the app.
		console.log('comment rejected: 503 LINEAR_ACTIVITY_SECRET is not configured');
		return new Response('LINEAR_ACTIVITY_SECRET is not configured', { status: 503 });
	}
	if (!bearerMatches(request.headers.get('authorization'), callerSecret)) {
		console.log('comment rejected: 401 bad or missing bearer');
		return new Response('Unauthorized', { status: 401 });
	}

	const rawBody = await request.text();
	logPayload(env, 'comment request body', rawBody);

	const input = commentInputFrom(rawBody);
	if ('error' in input) {
		console.log(`comment rejected: 400 ${input.error}`);
		return json({ ok: false, error: input.error }, 400);
	}

	console.log(`comment request: issue=${input.issueId} parent=${input.parentId ?? '-'}`);

	let token = await appActorToken(env);
	if (!token) {
		return json({ ok: false, error: 'LINEAR_CLIENT_ID/LINEAR_CLIENT_SECRET not configured' }, 503);
	}

	let response = await postComment(token, input);
	if (response.status === 401) {
		// App actor tokens carry no refresh token; the documented recovery is a fresh one.
		cachedAppToken = null;
		token = await fetchAppActorToken(env);
		if (token) {
			response = await postComment(token, input);
		}
	}

	const reply = await response.text();
	console.log(`comment: issue=${input.issueId} status=${response.status} reply=${reply.slice(0, MAX_LOGGED_REPLY)}`);

	// Linear answers 200 with an `errors` array on a rejected input, so status alone is not success.
	const succeeded = response.ok && reply.includes('"success":true');
	return json({ ok: succeeded, linearStatus: response.status, linear: safeJson(reply) }, succeeded ? 200 : 502);
}

type CommentInput = { issueId: string; body: string; parentId?: string };

function commentInputFrom(rawBody: string): CommentInput | { error: string } {
	let payload: unknown;
	try {
		payload = rawBody ? JSON.parse(rawBody) : null;
	} catch {
		return { error: 'body must be JSON' };
	}

	if (!isRecord(payload)) {
		return { error: 'body must be a JSON object' };
	}

	const issueId = payload.issueId;
	if (typeof issueId !== 'string' || !issueId) {
		return { error: 'issueId is required (the issue UUID, not its GROK-1 style identifier)' };
	}

	const body = payload.body;
	if (typeof body !== 'string' || !body) {
		return { error: 'body is required' };
	}

	const input: CommentInput = { issueId, body };
	if (typeof payload.parentId === 'string' && payload.parentId) {
		input.parentId = payload.parentId;
	}

	return input;
}

function postComment(token: string, input: CommentInput): Promise<Response> {
	return fetch(LINEAR_GRAPHQL_URL, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			query: 'mutation CommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url } } }',
			variables: { input },
		}),
	});
}

async function appActorToken(env: LinearCommentEnv): Promise<string | null> {
	if (cachedAppToken && cachedAppToken.expiresAt > Date.now()) {
		return cachedAppToken.value;
	}

	return fetchAppActorToken(env);
}

async function fetchAppActorToken(env: LinearCommentEnv): Promise<string | null> {
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

function logPayload(env: LinearCommentEnv, label: string, body: string): void {
	const flag = env.LOG_PAYLOADS?.trim().toLowerCase();
	if (flag === '0' || flag === 'false' || flag === 'off') {
		return;
	}
	console.log(`${label}: ${body.slice(0, MAX_LOGGED_BODY)}`);
}

function json(payload: unknown, status: number): Response {
	return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
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
