import { waitUntil } from '@vercel/functions';

// Linear retries failed deliveries after 1 minute, 1 hour, then 6 hours,
// reusing the original signed webhookTimestamp. A 60s window 401s those retries.
// Extra 30 minutes covers scheduling and transit past the nominal 6h retry.
const LINEAR_MAX_SKEW_MS = (6 * 60 + 30) * 60 * 1000;
const TEXT_PLAIN = 'text/plain; charset=utf-8';
// Cursor's reply is the only signal that a run actually started. Cap it so a long
// error page cannot flood the function log.
const MAX_LOGGED_CURSOR_REPLY = 500;
const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';
const LINEAR_TOKEN_URL = 'https://api.linear.app/oauth/token';
// Changing this scope string revokes every existing app actor token for the app.
const APP_TOKEN_SCOPES = 'read,write,app:assignable,app:mentionable';
// Linear marks a session unresponsive without an activity within 10 seconds.
const ACK_THOUGHT = 'On it — handing this to the Grok Bot run.';
// Retire a cached token early so it cannot expire mid-request.
const TOKEN_EXPIRY_MARGIN_MS = 60 * 1000;

let cachedAppToken: { value: string; expiresAt: number } | null = null;

// Tests only: module-level token cache would otherwise leak between cases.
export function resetAppTokenCache(): void {
	cachedAppToken = null;
}

export interface LinearEnv {
	LINEAR_CURSOR_WEBHOOK_URL?: string;
	LINEAR_CURSOR_WEBHOOK_KEY?: string;
	LINEAR_WEBHOOK_SECRET?: string;
	LINEAR_CLIENT_ID?: string;
	LINEAR_CLIENT_SECRET?: string;
}

function envFromProcess(): LinearEnv {
	return {
		LINEAR_CURSOR_WEBHOOK_URL: process.env.LINEAR_CURSOR_WEBHOOK_URL,
		LINEAR_CURSOR_WEBHOOK_KEY: process.env.LINEAR_CURSOR_WEBHOOK_KEY,
		LINEAR_WEBHOOK_SECRET: process.env.LINEAR_WEBHOOK_SECRET,
		LINEAR_CLIENT_ID: process.env.LINEAR_CLIENT_ID,
		LINEAR_CLIENT_SECRET: process.env.LINEAR_CLIENT_SECRET,
	};
}

export function GET(request: Request): Promise<Response> {
	return handleLinearRequest(request, envFromProcess());
}

export function POST(request: Request): Promise<Response> {
	return handleLinearRequest(request, envFromProcess(), waitUntil);
}

export function HEAD(request: Request): Promise<Response> {
	return handleLinearRequest(request, envFromProcess());
}

export default {
	fetch(request: Request): Promise<Response> {
		return handleLinearRequest(request, envFromProcess(), waitUntil);
	},
};

export async function handleLinearRequest(
	request: Request,
	env: LinearEnv,
	onBackground?: (task: Promise<unknown>) => void,
): Promise<Response> {
	const method = request.method.toUpperCase();

	if (method === 'GET' || method === 'HEAD') {
		return new Response(method === 'HEAD' ? null : 'ok', {
			status: 200,
			headers: { 'content-type': TEXT_PLAIN },
		});
	}

	if (method !== 'POST') {
		return new Response('Method Not Allowed', {
			status: 405,
			headers: { allow: 'GET, HEAD, POST' },
		});
	}

	const rawBody = await request.text();

	const signingSecret = env.LINEAR_WEBHOOK_SECRET?.trim();
	if (!signingSecret) {
		return new Response('LINEAR_WEBHOOK_SECRET is not configured', { status: 503 });
	}

	const verified = await verifyLinearSignature({
		signingSecret,
		signature: request.headers.get('linear-signature'),
		rawBody,
	});
	if (!verified) {
		return new Response('Unauthorized', { status: 401 });
	}

	const timestampMs = linearTimestampMs(rawBody, request);
	if (timestampMs !== null && Math.abs(Date.now() - timestampMs) > LINEAR_MAX_SKEW_MS) {
		return new Response('Unauthorized', { status: 401 });
	}

	// Ack first: the 10s activity deadline is tighter than anything Cursor needs.
	const sessionId = agentSessionIdFrom(rawBody);
	if (sessionId) {
		const ack = ackAgentSession(env, sessionId);
		if (onBackground) {
			onBackground(ack);
		}
	}

	const webhookUrl = env.LINEAR_CURSOR_WEBHOOK_URL?.trim();
	const webhookKey = env.LINEAR_CURSOR_WEBHOOK_KEY?.trim();
	if (webhookUrl && webhookKey) {
		// ACK Linear before Cursor returns. Linear times out at 5s and retries;
		// retries reuse webhookTimestamp and used to 401 against a 60s window.
		const pending = forwardToCursor(webhookUrl, webhookKey, rawBody);
		if (onBackground) {
			onBackground(pending);
		}
	}

	return new Response('ok', {
		status: 200,
		headers: { 'content-type': TEXT_PLAIN },
	});
}

export async function verifyLinearSignature(input: { signingSecret: string; signature: string | null; rawBody: string }): Promise<boolean> {
	const { signingSecret, signature, rawBody } = input;
	if (!signature) {
		return false;
	}

	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey('raw', encoder.encode(signingSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
	return timingSafeEqual(toHex(mac), signature.trim().toLowerCase());
}

function linearTimestampMs(rawBody: string, request: Request): number | null {
	try {
		const payload: unknown = rawBody ? JSON.parse(rawBody) : null;
		if (isRecord(payload) && typeof payload.webhookTimestamp === 'number') {
			return asUnixMs(payload.webhookTimestamp);
		}
	} catch {
		// Ignore unreadable JSON after a valid signature.
	}

	const header = request.headers.get('linear-timestamp');
	if (header) {
		const parsed = Number(header);
		if (Number.isFinite(parsed)) {
			return asUnixMs(parsed);
		}
	}

	return null;
}

function asUnixMs(value: number): number {
	// Linear documents milliseconds. Seconds are still ~1e9 in this century.
	return value < 1e12 ? value * 1000 : value;
}

async function forwardToCursor(webhookUrl: string, webhookKey: string, rawBody: string): Promise<void> {
	try {
		const response = await fetch(webhookUrl, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${webhookKey}`,
				'Content-Type': 'application/json',
			},
			body: rawBody,
		});

		const reply = (await response.text()).slice(0, MAX_LOGGED_CURSOR_REPLY);
		console.log(`cursor forward: status=${response.status} reply=${redactUrl(reply, webhookUrl)}`);
	} catch (error) {
		// Linear already received 200. Log why Cursor was missed, but do not surface it.
		const message = error instanceof Error ? error.message : 'unknown error';
		console.log(`cursor forward failed: ${redactUrl(message, webhookUrl)}`);
	}
}

// The destination URL is a secret env var; keep it out of the log even when a
// fetch error or Cursor error page echoes it back.
function redactUrl(text: string, webhookUrl: string): string {
	return webhookUrl ? text.split(webhookUrl).join('<cursor-webhook-url>') : text;
}

function agentSessionIdFrom(rawBody: string): string | null {
	try {
		const payload: unknown = rawBody ? JSON.parse(rawBody) : null;
		if (!isRecord(payload) || payload.type !== 'AgentSessionEvent') {
			return null;
		}
		const session = payload.agentSession;
		if (isRecord(session) && typeof session.id === 'string') {
			return session.id;
		}
	} catch {
		// Ignore unreadable JSON after a valid signature.
	}

	return null;
}

export async function ackAgentSession(env: LinearEnv, agentSessionId: string): Promise<void> {
	try {
		let token = await appActorToken(env);
		if (!token) {
			console.log('agent ack skipped: LINEAR_CLIENT_ID/LINEAR_CLIENT_SECRET not configured');
			return;
		}

		let response = await postThought(token, agentSessionId);
		if (response.status === 401) {
			// App actor tokens have no refresh token; the documented recovery is a new one.
			cachedAppToken = null;
			token = await fetchAppActorToken(env);
			if (token) {
				response = await postThought(token, agentSessionId);
			}
		}

		const reply = (await response.text()).slice(0, MAX_LOGGED_CURSOR_REPLY);
		console.log(`agent ack: session=${agentSessionId} status=${response.status} reply=${reply}`);
	} catch (error) {
		console.log(`agent ack failed: ${error instanceof Error ? error.message : 'unknown error'}`);
	}
}

function postThought(token: string, agentSessionId: string): Promise<Response> {
	return fetch(LINEAR_GRAPHQL_URL, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			query: 'mutation AgentActivityCreate($input: AgentActivityCreateInput!) { agentActivityCreate(input: $input) { success } }',
			variables: { input: { agentSessionId, content: { type: 'thought', body: ACK_THOUGHT } } },
		}),
	});
}

async function appActorToken(env: LinearEnv): Promise<string | null> {
	if (cachedAppToken && cachedAppToken.expiresAt > Date.now()) {
		return cachedAppToken.value;
	}

	return fetchAppActorToken(env);
}

async function fetchAppActorToken(env: LinearEnv): Promise<string | null> {
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

	const lifetimeMs = (payload.expires_in ?? 0) * 1000;
	cachedAppToken = { value: payload.access_token, expiresAt: Date.now() + lifetimeMs - TOKEN_EXPIRY_MARGIN_MS };
	return payload.access_token;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function toHex(buffer: ArrayBuffer): string {
	return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
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
