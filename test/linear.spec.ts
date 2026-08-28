import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleRequest } from '../api/index';
import { handleLinearRequest, verifyLinearSignature } from '../api/linear';

const SLACK_WEBHOOK_URL = 'https://api2.cursor.sh/automations/webhook/11111111-1111-1111-1111-111111111111';
const SLACK_WEBHOOK_KEY = 'crsr_slack_test_key_not_real';
const LINEAR_WEBHOOK_URL = 'https://api2.cursor.sh/automations/webhook/22222222-2222-2222-2222-222222222222';
const LINEAR_WEBHOOK_KEY = 'crsr_linear_test_key_not_real';

const linearEnv = {
	LINEAR_CURSOR_WEBHOOK_URL: LINEAR_WEBHOOK_URL,
	LINEAR_CURSOR_WEBHOOK_KEY: LINEAR_WEBHOOK_KEY,
};

const slackEnv = {
	CURSOR_WEBHOOK_URL: SLACK_WEBHOOK_URL,
	CURSOR_WEBHOOK_KEY: SLACK_WEBHOOK_KEY,
};

type CapturedFetch = {
	url: string;
	method: string;
	authorization: string | null;
	contentType: string | null;
	body: string;
};

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('GET /linear health', () => {
	it('returns a short health string and no secrets', async () => {
		const response = await handleLinearRequest(new Request('https://proxy.example/linear'), linearEnv);
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).toBe('ok');
		expect(text).not.toContain(LINEAR_WEBHOOK_KEY);
		expect(text).not.toContain('crsr_');
	});
});

describe('Linear event forward', () => {
	const body = JSON.stringify({
		action: 'create',
		type: 'AgentSessionEvent',
		webhookTimestamp: Date.now(),
	});

	it('POSTs the raw body to LINEAR_CURSOR_WEBHOOK_URL with a Bearer header and never puts the key in the URL', async () => {
		const captured: CapturedFetch[] = [];
		mockCursorFetch(captured);

		const response = await handleLinearRequest(
			new Request('https://proxy.example/linear', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body,
			}),
			linearEnv,
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('ok');
		expect(captured).toHaveLength(1);
		expect(captured[0].method).toBe('POST');
		expect(captured[0].url).toBe(LINEAR_WEBHOOK_URL);
		expect(captured[0].url).not.toContain(LINEAR_WEBHOOK_KEY);
		expect(captured[0].url).not.toBe(SLACK_WEBHOOK_URL);
		expect(new URL(captured[0].url).search).toBe('');
		expect(captured[0].authorization).toBe(`Bearer ${LINEAR_WEBHOOK_KEY}`);
		expect(captured[0].contentType).toMatch(/application\/json/);
		expect(captured[0].body).toBe(body);
	});

	it('still returns 200 when Cursor fails so Linear does not retry-storm', async () => {
		mockCursorFetch([], { status: 500, body: 'nope' });

		const response = await handleLinearRequest(
			new Request('https://proxy.example/linear', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body,
			}),
			linearEnv,
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('ok');
	});

	it('still returns 200 with no dest env so the Linear app can be created first', async () => {
		const fetchMock = mockCursorFetch();

		const response = await handleLinearRequest(
			new Request('https://proxy.example/linear', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body,
			}),
			{},
		);

		expect(response.status).toBe(200);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('Linear request signing', () => {
	const signingSecret = 'test_linear_signing_secret_not_real';
	const now = Date.now();
	const body = JSON.stringify({
		action: 'create',
		type: 'Comment',
		webhookTimestamp: now,
	});

	it('forwards when LINEAR_WEBHOOK_SECRET is unset', async () => {
		const captured: CapturedFetch[] = [];
		mockCursorFetch(captured);

		const response = await handleLinearRequest(
			new Request('https://proxy.example/linear', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body,
			}),
			linearEnv,
		);

		expect(response.status).toBe(200);
		expect(captured).toHaveLength(1);
	});

	it('rejects a bad signature before forwarding when the signing secret is set', async () => {
		const fetchMock = mockCursorFetch();

		const response = await handleLinearRequest(
			new Request('https://proxy.example/linear', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'linear-signature': 'deadbeef',
					'linear-timestamp': String(now),
				},
				body,
			}),
			{ ...linearEnv, LINEAR_WEBHOOK_SECRET: signingSecret },
		);

		expect(response.status).toBe(401);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('accepts a valid Linear signature computed independently and forwards', async () => {
		const captured: CapturedFetch[] = [];
		mockCursorFetch(captured);
		const signature = nodeLinearSignature(signingSecret, body);

		expect(
			await verifyLinearSignature({
				signingSecret,
				signature,
				rawBody: body,
			}),
		).toBe(true);

		const response = await handleLinearRequest(
			new Request('https://proxy.example/linear', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'linear-signature': signature,
					'linear-timestamp': String(now),
				},
				body,
			}),
			{ ...linearEnv, LINEAR_WEBHOOK_SECRET: signingSecret },
		);

		expect(response.status).toBe(200);
		expect(captured).toHaveLength(1);
		expect(captured[0].url).toBe(LINEAR_WEBHOOK_URL);
	});

	it('rejects a stale Linear timestamp when the signing secret is set', async () => {
		const fetchMock = mockCursorFetch();
		const staleBody = JSON.stringify({
			action: 'create',
			type: 'Comment',
			webhookTimestamp: now - 5 * 60 * 1000,
		});
		const signature = nodeLinearSignature(signingSecret, staleBody);

		const response = await handleLinearRequest(
			new Request('https://proxy.example/linear', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'linear-signature': signature,
					'linear-timestamp': String(now - 5 * 60 * 1000),
				},
				body: staleBody,
			}),
			{ ...linearEnv, LINEAR_WEBHOOK_SECRET: signingSecret },
		);

		expect(response.status).toBe(401);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('Slack path stays on Slack env', () => {
	it('does not send Slack events to LINEAR_CURSOR_WEBHOOK_URL', async () => {
		const captured: CapturedFetch[] = [];
		mockCursorFetch(captured);

		const slackBody = JSON.stringify({
			type: 'event_callback',
			event: { type: 'app_mention', text: 'hello' },
		});

		const response = await handleRequest(
			new Request('https://proxy.example/', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: slackBody,
			}),
			slackEnv,
		);

		expect(response.status).toBe(200);
		expect(captured).toHaveLength(1);
		expect(captured[0].url).toBe(SLACK_WEBHOOK_URL);
		expect(captured[0].url).not.toBe(LINEAR_WEBHOOK_URL);
		expect(captured[0].authorization).toBe(`Bearer ${SLACK_WEBHOOK_KEY}`);
	});
});

function mockCursorFetch(captured: CapturedFetch[] = [], reply: { status: number; body: string } = { status: 200, body: '{"success":true}' }) {
	const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		captured.push({
			url: request.url,
			method: request.method,
			authorization: request.headers.get('authorization'),
			contentType: request.headers.get('content-type'),
			body: await request.text(),
		});
		return new Response(reply.body, { status: reply.status });
	});
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

function nodeLinearSignature(secret: string, rawBody: string): string {
	return createHmac('sha256', secret).update(rawBody).digest('hex');
}
