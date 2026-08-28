import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitUntil } from '@vercel/functions';
import { POST, handleLinearRequest, resetAppTokenCache, verifyLinearSignature } from '../api/linear';
import { handleSlackRequest } from '../api/slack';

vi.mock('@vercel/functions', () => ({
	waitUntil: vi.fn(),
}));

const SLACK_WEBHOOK_URL = 'https://api2.cursor.sh/automations/webhook/11111111-1111-1111-1111-111111111111';
const SLACK_WEBHOOK_KEY = 'crsr_slack_test_key_not_real';
const LINEAR_WEBHOOK_URL = 'https://api2.cursor.sh/automations/webhook/22222222-2222-2222-2222-222222222222';
const LINEAR_WEBHOOK_KEY = 'crsr_linear_test_key_not_real';
const LINEAR_SIGNING_SECRET = 'test_linear_signing_secret_not_real';

const linearEnv = {
	LINEAR_CURSOR_WEBHOOK_URL: LINEAR_WEBHOOK_URL,
	LINEAR_CURSOR_WEBHOOK_KEY: LINEAR_WEBHOOK_KEY,
	LINEAR_WEBHOOK_SECRET: LINEAR_SIGNING_SECRET,
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
	resetAppTokenCache();
});

function signedLinearRequest(body: string, extraHeaders: Record<string, string> = {}): Request {
	return new Request('https://proxy.example/linear', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'linear-signature': nodeLinearSignature(LINEAR_SIGNING_SECRET, body),
			...extraHeaders,
		},
		body,
	});
}

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

		const response = await handleLinearRequest(signedLinearRequest(body), linearEnv, (task) => void task);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('ok');
		await expectForward(captured);
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

		const response = await handleLinearRequest(signedLinearRequest(body), linearEnv, (task) => void task);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('ok');
	});

	it('ACKs Linear before Cursor returns so a slow hop cannot 401 Linear retries', async () => {
		const captured: CapturedFetch[] = [];
		let releaseCursor!: (value: Response) => void;
		const hung = new Promise<Response>((resolve) => {
			releaseCursor = resolve;
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const request = new Request(input, init);
				captured.push({
					url: request.url,
					method: request.method,
					authorization: request.headers.get('authorization'),
					contentType: request.headers.get('content-type'),
					body: await request.text(),
				});
				return hung;
			}),
		);

		const started = Date.now();
		const response = await handleLinearRequest(signedLinearRequest(body), linearEnv);
		expect(Date.now() - started).toBeLessThan(1000);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('ok');

		releaseCursor(new Response('{"success":true}', { status: 200 }));
	});

	it('still returns 200 with no dest env so the Linear app can be created first', async () => {
		const fetchMock = mockCursorFetch();

		const response = await handleLinearRequest(signedLinearRequest(body), {
			LINEAR_WEBHOOK_SECRET: LINEAR_SIGNING_SECRET,
		});

		expect(response.status).toBe(200);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('Linear request signing', () => {
	const now = Date.now();
	const body = JSON.stringify({
		action: 'create',
		type: 'Comment',
		webhookTimestamp: now,
	});

	it('rejects when LINEAR_WEBHOOK_SECRET is unset so the Cursor key cannot be invoked unsigned', async () => {
		const fetchMock = mockCursorFetch();

		const response = await handleLinearRequest(
			new Request('https://proxy.example/linear', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body,
			}),
			{
				LINEAR_CURSOR_WEBHOOK_URL: LINEAR_WEBHOOK_URL,
				LINEAR_CURSOR_WEBHOOK_KEY: LINEAR_WEBHOOK_KEY,
			},
		);

		expect(response.status).toBe(503);
		expect(fetchMock).not.toHaveBeenCalled();
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
			linearEnv,
		);

		expect(response.status).toBe(401);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('accepts a valid Linear signature computed independently and forwards', async () => {
		const captured: CapturedFetch[] = [];
		mockCursorFetch(captured);
		const signature = nodeLinearSignature(LINEAR_SIGNING_SECRET, body);

		expect(
			await verifyLinearSignature({
				signingSecret: LINEAR_SIGNING_SECRET,
				signature,
				rawBody: body,
			}),
		).toBe(true);

		const response = await handleLinearRequest(
			signedLinearRequest(body, { 'linear-timestamp': String(now) }),
			linearEnv,
			(task) => void task,
		);

		expect(response.status).toBe(200);
		await expectForward(captured);
		expect(captured[0].url).toBe(LINEAR_WEBHOOK_URL);
	});

	it('accepts Linear retry timestamps inside the 6h delivery window', async () => {
		const captured: CapturedFetch[] = [];
		mockCursorFetch(captured);
		const retryBody = JSON.stringify({
			action: 'create',
			type: 'Comment',
			webhookTimestamp: now - (6 * 60 - 1) * 60 * 1000,
		});

		const response = await handleLinearRequest(signedLinearRequest(retryBody), linearEnv, (task) => void task);

		expect(response.status).toBe(200);
		await expectForward(captured);
	});

	it('accepts a 6h retry that arrives a few minutes late', async () => {
		const captured: CapturedFetch[] = [];
		mockCursorFetch(captured);
		const retryBody = JSON.stringify({
			action: 'create',
			type: 'Comment',
			webhookTimestamp: now - (6 * 60 + 5) * 60 * 1000,
		});

		const response = await handleLinearRequest(signedLinearRequest(retryBody), linearEnv, (task) => void task);

		expect(response.status).toBe(200);
		await expectForward(captured);
	});

	it('Vercel POST keeps the Cursor forward alive with waitUntil after ACKing Linear', async () => {
		vi.stubEnv('LINEAR_CURSOR_WEBHOOK_URL', LINEAR_WEBHOOK_URL);
		vi.stubEnv('LINEAR_CURSOR_WEBHOOK_KEY', LINEAR_WEBHOOK_KEY);
		vi.stubEnv('LINEAR_WEBHOOK_SECRET', LINEAR_SIGNING_SECRET);

		const captured: CapturedFetch[] = [];
		mockCursorFetch(captured);
		const waitUntilMock = vi.mocked(waitUntil);
		waitUntilMock.mockClear();

		const response = await POST(signedLinearRequest(body));

		expect(response.status).toBe(200);
		expect(waitUntilMock).toHaveBeenCalledTimes(1);
		await expectForward(captured);
	});

	it('treats webhookTimestamp seconds as unix seconds so a unit mismatch cannot 401 Linear', async () => {
		const captured: CapturedFetch[] = [];
		mockCursorFetch(captured);
		const secondsBody = JSON.stringify({
			action: 'create',
			type: 'Comment',
			webhookTimestamp: Math.floor(now / 1000),
		});

		const response = await handleLinearRequest(signedLinearRequest(secondsBody), linearEnv, (task) => void task);

		expect(response.status).toBe(200);
		await expectForward(captured);
	});

	it('rejects a stale Linear timestamp when the signing secret is set', async () => {
		const fetchMock = mockCursorFetch();
		const staleBody = JSON.stringify({
			action: 'create',
			type: 'Comment',
			webhookTimestamp: now - 7 * 60 * 60 * 1000,
		});

		const response = await handleLinearRequest(
			signedLinearRequest(staleBody, { 'linear-timestamp': String(now - 7 * 60 * 60 * 1000) }),
			linearEnv,
		);

		expect(response.status).toBe(401);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('prefers the signed webhookTimestamp over an unauthenticated linear-timestamp header', async () => {
		const fetchMock = mockCursorFetch();
		const staleBody = JSON.stringify({
			action: 'create',
			type: 'Comment',
			webhookTimestamp: now - 7 * 60 * 60 * 1000,
		});

		const response = await handleLinearRequest(signedLinearRequest(staleBody, { 'linear-timestamp': String(now) }), linearEnv);

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

		const response = await handleSlackRequest(
			new Request('https://proxy.example/slack', {
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

describe('Agent session ack', () => {
	const agentEnv = { ...linearEnv, LINEAR_CLIENT_ID: 'client_id_not_real', LINEAR_CLIENT_SECRET: 'client_secret_not_real' };
	const agentBody = JSON.stringify({
		type: 'AgentSessionEvent',
		action: 'created',
		agentSession: { id: 'session-123' },
		webhookTimestamp: Date.now(),
	});

	it('posts a thought activity so Linear does not mark the session unresponsive', async () => {
		const calls = mockRoutedFetch();

		const response = await handleLinearRequest(signedLinearRequest(agentBody), agentEnv, (task) => void task);
		expect(response.status).toBe(200);

		const mutation = await waitForCall(calls, 'api.linear.app/graphql');
		expect(mutation.authorization).toBe('Bearer app_token_not_real');
		const sent = JSON.parse(mutation.body);
		expect(sent.query).toContain('agentActivityCreate');
		expect(sent.variables.input.agentSessionId).toBe('session-123');
		expect(sent.variables.input.content.type).toBe('thought');
		expect(typeof sent.variables.input.content.body).toBe('string');
	});

	it('requests the app actor token with client_credentials and never puts it in the URL', async () => {
		const calls = mockRoutedFetch();

		await handleLinearRequest(signedLinearRequest(agentBody), agentEnv, (task) => void task);

		const token = await waitForCall(calls, 'oauth/token');
		expect(new URL(token.url).search).toBe('');
		expect(token.body).toContain('grant_type=client_credentials');
		expect(token.body).toContain('app%3Amentionable');
	});

	it('fetches a fresh token and retries once when Linear rejects the cached one', async () => {
		let graphqlCalls = 0;
		const calls = mockRoutedFetch({
			graphql: () => {
				graphqlCalls += 1;
				return graphqlCalls === 1
					? new Response('unauthorized', { status: 401 })
					: new Response('{"data":{"agentActivityCreate":{"success":true}}}', { status: 200 });
			},
		});

		await handleLinearRequest(signedLinearRequest(agentBody), agentEnv, (task) => void task);

		await vi.waitFor(() => {
			expect(calls.filter((call) => call.url.includes('graphql'))).toHaveLength(2);
		});
		expect(calls.filter((call) => call.url.includes('oauth/token'))).toHaveLength(2);
	});

	it('skips the ack when the app credentials are unset so the Cursor hop still runs', async () => {
		const calls = mockRoutedFetch();

		await handleLinearRequest(signedLinearRequest(agentBody), linearEnv, (task) => void task);

		await waitForCall(calls, 'api2.cursor.sh');
		expect(calls.some((call) => call.url.includes('graphql'))).toBe(false);
	});

	it('does not ack a payload that is not an AgentSessionEvent', async () => {
		const calls = mockRoutedFetch();
		const commentBody = JSON.stringify({ type: 'Comment', action: 'create', webhookTimestamp: Date.now() });

		await handleLinearRequest(signedLinearRequest(commentBody), agentEnv, (task) => void task);

		await waitForCall(calls, 'api2.cursor.sh');
		expect(calls.some((call) => call.url.includes('graphql'))).toBe(false);
	});
});

type RoutedCall = { url: string; body: string; authorization: string | null };

function mockRoutedFetch(overrides: { graphql?: () => Response } = {}): RoutedCall[] {
	const calls: RoutedCall[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			calls.push({ url: request.url, body: await request.text(), authorization: request.headers.get('authorization') });

			if (request.url.includes('oauth/token')) {
				return new Response(JSON.stringify({ access_token: 'app_token_not_real', expires_in: 2591999 }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			if (request.url.includes('graphql')) {
				return overrides.graphql ? overrides.graphql() : new Response('{"data":{"agentActivityCreate":{"success":true}}}', { status: 200 });
			}
			return new Response('{"success":true}', { status: 200 });
		}),
	);
	return calls;
}

async function waitForCall(calls: RoutedCall[], fragment: string): Promise<RoutedCall> {
	let found: RoutedCall | undefined;
	await vi.waitFor(() => {
		found = calls.find((call) => call.url.includes(fragment));
		expect(found).toBeDefined();
	});
	return found as RoutedCall;
}

async function expectForward(captured: CapturedFetch[]): Promise<void> {
	await vi.waitFor(() => {
		expect(captured).toHaveLength(1);
	});
}

function mockCursorFetch(
	captured: CapturedFetch[] = [],
	reply: { status: number; body: string } = { status: 200, body: '{"success":true}' },
) {
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
