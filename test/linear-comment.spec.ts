import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleLinearCommentRequest, resetAppTokenCache } from '../api/linear-comment';

const CALLER_SECRET = 'relay_secret_not_real';
const ISSUE_ID = '2572ebc7-5f38-44d4-b509-8e5cd3ebada3';
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
	return new Request('https://proxy.example/linear/comment', {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: typeof body === 'string' ? body : JSON.stringify(body),
	});
}

describe('POST /linear/comment', () => {
	it('creates a comment on the issue as the app', async () => {
		const calls = mockRoutedFetch();

		const response = await handleLinearCommentRequest(post({ issueId: ISSUE_ID, body: 'Looked into this.' }), env);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ ok: true });

		const mutation = calls.find((call) => call.url.includes('graphql')) as RoutedCall;
		expect(mutation.authorization).toBe('Bearer app_token_not_real');
		const sent = JSON.parse(mutation.body);
		expect(sent.query).toContain('commentCreate');
		expect(sent.variables.input).toEqual({ issueId: ISSUE_ID, body: 'Looked into this.' });
	});

	it('threads the reply when a parentId is given', async () => {
		const calls = mockRoutedFetch();

		await handleLinearCommentRequest(post({ issueId: ISSUE_ID, body: 'Replying.', parentId: 'parent-1' }), env);

		const sent = JSON.parse((calls.find((call) => call.url.includes('graphql')) as RoutedCall).body);
		expect(sent.variables.input.parentId).toBe('parent-1');
	});

	it('reports failure when Linear returns 200 with an errors array', async () => {
		mockRoutedFetch({ graphql: () => new Response('{"errors":[{"message":"bad issue"}]}', { status: 200 }) });

		const response = await handleLinearCommentRequest(post({ issueId: ISSUE_ID, body: 'hi' }), env);

		expect(response.status).toBe(502);
		expect(await response.json()).toMatchObject({ ok: false });
	});

	it('refuses an unauthenticated caller so the route is not an open relay', async () => {
		const calls = mockRoutedFetch();

		const response = await handleLinearCommentRequest(post({ issueId: ISSUE_ID, body: 'hi' }, {}), env);

		expect(response.status).toBe(401);
		expect(calls).toHaveLength(0);
	});

	it('fails closed when no shared secret is configured', async () => {
		mockRoutedFetch();
		const response = await handleLinearCommentRequest(post({ issueId: ISSUE_ID, body: 'hi' }), {
			LINEAR_CLIENT_ID: 'x',
			LINEAR_CLIENT_SECRET: 'y',
		});
		expect(response.status).toBe(503);
	});

	it('requires issueId and body', async () => {
		mockRoutedFetch();
		expect((await handleLinearCommentRequest(post({ body: 'hi' }), env)).status).toBe(400);
		expect((await handleLinearCommentRequest(post({ issueId: ISSUE_ID }), env)).status).toBe(400);
	});

	it('answers GET with a health string', async () => {
		const response = await handleLinearCommentRequest(new Request('https://proxy.example/linear/comment'), env);
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
			return overrides.graphql
				? overrides.graphql()
				: new Response('{"data":{"commentCreate":{"success":true,"comment":{"id":"c1","url":"https://linear.app/x"}}}}', { status: 200 });
		}),
	);
	return calls;
}
