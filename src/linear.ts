// Linear retries failed deliveries after 1 minute, 1 hour, then 6 hours,
// reusing the original signed webhookTimestamp. A 60s window 401s those retries.
// Extra 30 minutes covers scheduling and transit past the nominal 6h retry.
const LINEAR_MAX_SKEW_MS = (6 * 60 + 30) * 60 * 1000;
const TEXT_PLAIN = 'text/plain; charset=utf-8';

export interface LinearEnv {
	LINEAR_CURSOR_WEBHOOK_URL?: string;
	LINEAR_CURSOR_WEBHOOK_KEY?: string;
	LINEAR_WEBHOOK_SECRET?: string;
}

export async function handleLinearRequest(
	request: Request,
	env: LinearEnv,
	waitUntil?: (task: Promise<unknown>) => void,
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

	const webhookUrl = env.LINEAR_CURSOR_WEBHOOK_URL?.trim();
	const webhookKey = env.LINEAR_CURSOR_WEBHOOK_KEY?.trim();
	if (webhookUrl && webhookKey) {
		// ACK Linear before Cursor returns. Linear times out at 5s and retries;
		// retries reuse webhookTimestamp and used to 401 against a 60s window.
		const pending = forwardToCursor(webhookUrl, webhookKey, rawBody);
		if (waitUntil) {
			waitUntil(pending);
		}
	}

	return new Response('ok', {
		status: 200,
		headers: { 'content-type': TEXT_PLAIN },
	});
}

export async function verifyLinearSignature(input: {
	signingSecret: string;
	signature: string | null;
	rawBody: string;
}): Promise<boolean> {
	const { signingSecret, signature, rawBody } = input;
	if (!signature) {
		return false;
	}

	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey('raw', encoder.encode(signingSecret), { name: 'HMAC', hash: 'SHA-256' }, false, [
		'sign',
	]);
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
		await fetch(webhookUrl, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${webhookKey}`,
				'Content-Type': 'application/json',
			},
			body: rawBody,
		});
	} catch {
		// Linear already received 200. Do not surface Cursor failures.
	}
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
