const LINEAR_MAX_SKEW_MS = 60 * 1000;
const TEXT_PLAIN = 'text/plain; charset=utf-8';

export interface LinearEnv {
	LINEAR_CURSOR_WEBHOOK_URL?: string;
	LINEAR_CURSOR_WEBHOOK_KEY?: string;
	LINEAR_WEBHOOK_SECRET?: string;
}

function envFromProcess(): LinearEnv {
	return {
		LINEAR_CURSOR_WEBHOOK_URL: process.env.LINEAR_CURSOR_WEBHOOK_URL,
		LINEAR_CURSOR_WEBHOOK_KEY: process.env.LINEAR_CURSOR_WEBHOOK_KEY,
		LINEAR_WEBHOOK_SECRET: process.env.LINEAR_WEBHOOK_SECRET,
	};
}

export function GET(request: Request): Promise<Response> {
	return handleLinearRequest(request, envFromProcess());
}

export function POST(request: Request): Promise<Response> {
	return handleLinearRequest(request, envFromProcess());
}

export function HEAD(request: Request): Promise<Response> {
	return handleLinearRequest(request, envFromProcess());
}

export default {
	fetch(request: Request): Promise<Response> {
		return handleLinearRequest(request, envFromProcess());
	},
};

export async function handleLinearRequest(request: Request, env: LinearEnv): Promise<Response> {
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
	if (signingSecret) {
		const verified = await verifyLinearSignature({
			signingSecret,
			signature: request.headers.get('linear-signature'),
			rawBody,
		});
		if (!verified) {
			return new Response('Unauthorized', { status: 401 });
		}

		const timestampMs = linearTimestampMs(request, rawBody);
		if (timestampMs !== null && Math.abs(Date.now() - timestampMs) > LINEAR_MAX_SKEW_MS) {
			return new Response('Unauthorized', { status: 401 });
		}
	}

	const webhookUrl = env.LINEAR_CURSOR_WEBHOOK_URL?.trim();
	const webhookKey = env.LINEAR_CURSOR_WEBHOOK_KEY?.trim();
	if (webhookUrl && webhookKey) {
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
			// Always 200 to Linear after accept. Linear retries non-200.
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
	return timingSafeEqual(toHex(mac), signature.toLowerCase());
}

function linearTimestampMs(request: Request, rawBody: string): number | null {
	const header = request.headers.get('linear-timestamp');
	if (header) {
		const parsed = Number(header);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}

	try {
		const payload: unknown = rawBody ? JSON.parse(rawBody) : null;
		if (isRecord(payload) && typeof payload.webhookTimestamp === 'number') {
			return payload.webhookTimestamp;
		}
	} catch {
		// Ignore unreadable JSON after a valid signature.
	}

	return null;
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
