import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleLinearActivityRequest, resetAppTokenCache } from '../api/linear-activity';

const CALLER_SECRET = 'relay_secret_not_real';
const env = {
	LINEAR_CLIENT_ID: 'client_id_not_real',
	LINEAR_CLIENT_SECRET: 'client_secret_not_real',
	LINEAR_ACTIVITY_SECRET: CALLER_SECRET,
};

type RoutedCall = { url: string; body: string; authorization: string | null };

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	resetAppTokenCache();
});

function post(body: unknown, headers: Record<string, string> = { authorization: `Bearer ${CALLER_SECRET}` }): Request {
	return new Request('https://proxy.example/linear/activity', {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: typeof body === 'string' ? body : JSON.stringify(body),
	});
}

describe('POST /linear/activity', () => {
	it('relays a response activity to Linear as the app', async () => {
		const calls = mockRoutedFetch();

		const response = await handleLinearActivityRequest(post({ agentSessionId: 'session-123', type: 'response', body: 'Done.' }), env);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ ok: true });

		const mutation = calls.find((call) => call.url.includes('graphql')) as RoutedCall;
		expect(mutation.authorization).toBe('Bearer app_token_not_real');
		const sent = JSON.parse(mutation.body);
		expect(sent.variables.input.agentSessionId).toBe('session-123');
		expect(sent.variables.input.content).toEqual({ type: 'response', body: 'Done.' });
	});

	it('passes action activities through with their optional result', async () => {
		const calls = mockRoutedFetch();

		await handleLinearActivityRequest(
			post({ agentSessionId: 's1', type: 'action', action: 'Searched', parameter: 'weather', result: '12C' }),
			env,
		);

		const sent = JSON.parse((calls.find((call) => call.url.includes('graphql')) as RoutedCall).body);
		expect(sent.variables.input.content).toEqual({ type: 'action', action: 'Searched', parameter: 'weather', result: '12C' });
	});

	it('reports failure when Linear returns 200 with an errors array', async () => {
		mockRoutedFetch({ graphql: () => new Response('{"errors":[{"message":"bad session"}]}', { status: 200 }) });

		const response = await handleLinearActivityRequest(post({ agentSessionId: 's1', type: 'response', body: 'Done.' }), env);

		expect(response.status).toBe(502);
		expect(await response.json()).toMatchObject({ ok: false });
	});

	it('refuses an unauthenticated caller so the route is not an open relay', async () => {
		const calls = mockRoutedFetch();

		const response = await handleLinearActivityRequest(post({ agentSessionId: 's1', type: 'response', body: 'hi' }, {}), env);

		expect(response.status).toBe(401);
		expect(calls).toHaveLength(0);
	});

	it('refuses a wrong shared secret', async () => {
		mockRoutedFetch();
		const response = await handleLinearActivityRequest(
			post({ agentSessionId: 's1', type: 'response', body: 'hi' }, { authorization: 'Bearer wrong' }),
			env,
		);
		expect(response.status).toBe(401);
	});

	it('fails closed when no shared secret is configured', async () => {
		mockRoutedFetch();
		const response = await handleLinearActivityRequest(post({ agentSessionId: 's1', type: 'response', body: 'hi' }), {
			LINEAR_CLIENT_ID: 'x',
			LINEAR_CLIENT_SECRET: 'y',
		});
		expect(response.status).toBe(503);
	});

	it('rejects a prompt type, which only users can create', async () => {
		mockRoutedFetch();
		const response = await handleLinearActivityRequest(post({ agentSessionId: 's1', type: 'prompt', body: 'hi' }), env);
		expect(response.status).toBe(400);
	});

	it('requires agentSessionId', async () => {
		mockRoutedFetch();
		const response = await handleLinearActivityRequest(post({ type: 'response', body: 'hi' }), env);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: 'agentSessionId is required' });
	});

	it('answers GET with a health string', async () => {
		const response = await handleLinearActivityRequest(new Request('https://proxy.example/linear/activity'), env);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('ok');
	});
});

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
			return overrides.graphql ? overrides.graphql() : new Response('{"data":{"agentActivityCreate":{"success":true}}}', { status: 200 });
		}),
	);
	return calls;
}
