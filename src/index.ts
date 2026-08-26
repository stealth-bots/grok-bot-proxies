const SLACK_MAX_SKEW_SECONDS = 60 * 5;
const TEXT_PLAIN = 'text/plain; charset=utf-8';

export interface SlackEnv {
	CURSOR_WEBHOOK_URL?: string;
	CURSOR_WEBHOOK_KEY?: string;
	SLACK_SIGNING_SECRET?: string;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		return handleRequest(request, env);
	},
};

export async function handleRequest(request: Request, env: SlackEnv): Promise<Response> {
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

	const signingSecret = env.SLACK_SIGNING_SECRET?.trim();
	if (signingSecret) {
		const verified = await verifySlackSignature({
			signingSecret,
			signature: request.headers.get('x-slack-signature'),
			timestamp: request.headers.get('x-slack-request-timestamp'),
			rawBody,
		});
		if (!verified) {
			return new Response('Unauthorized', { status: 401 });
		}
	}

	let payload: unknown;
	try {
		payload = rawBody ? JSON.parse(rawBody) : null;
	} catch {
		return new Response('Bad Request', { status: 400 });
	}

	if (isRecord(payload) && payload.type === 'url_verification') {
		if (typeof payload.challenge !== 'string') {
			return new Response('Bad Request', { status: 400 });
		}
		return new Response(payload.challenge, {
			status: 200,
			headers: { 'content-type': TEXT_PLAIN },
		});
	}

	const webhookUrl = env.CURSOR_WEBHOOK_URL?.trim();
	const webhookKey = env.CURSOR_WEBHOOK_KEY?.trim();
	if (!webhookUrl || !webhookKey) {
		return new Response('Server misconfigured', { status: 500 });
	}

	let cursorResponse: Response;
	try {
		cursorResponse = await fetch(webhookUrl, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${webhookKey}`,
				'Content-Type': 'application/json',
			},
			body: rawBody,
		});
	} catch {
		return new Response('Bad Gateway', { status: 502 });
	}

	if (!cursorResponse.ok) {
		return new Response('Bad Gateway', { status: 502 });
	}

	return new Response('ok', {
		status: 200,
		headers: { 'content-type': TEXT_PLAIN },
	});
}

export async function verifySlackSignature(input: {
	signingSecret: string;
	signature: string | null;
	timestamp: string | null;
	rawBody: string;
	nowSeconds?: number;
}): Promise<boolean> {
	const { signingSecret, signature, timestamp, rawBody } = input;
	if (!signature || !timestamp) {
		return false;
	}

	const requestTime = Number(timestamp);
	if (!Number.isFinite(requestTime)) {
		return false;
	}

	const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
	if (Math.abs(nowSeconds - requestTime) > SLACK_MAX_SKEW_SECONDS) {
		return false;
	}

	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey('raw', encoder.encode(signingSecret), { name: 'HMAC', hash: 'SHA-256' }, false, [
		'sign',
	]);
	const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`v0:${timestamp}:${rawBody}`));
	const expected = `v0=${toHex(mac)}`;
	return timingSafeEqual(expected, signature);
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
