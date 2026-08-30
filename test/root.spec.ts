import { afterEach, describe, expect, it, vi } from 'vitest';
import root from '../api/index';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('GET /', () => {
	it('serves a plain-text page naming the project and its source', async () => {
		const response = await root.fetch(new Request('https://proxy.example/'));

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toMatch(/text\/plain/);
		const html = await response.text();
		expect(html).toContain('grok-bot proxies');
		expect(html).toContain('https://github.com/stealth-bots/grok-bot-proxies');
		expect(html).toContain('https://www.stealth-factory.co');
		expect(html).toContain('https://x.com/wiiiimm');
	});

	it('lists the routes but never a secret', async () => {
		const html = await (await root.fetch(new Request('https://proxy.example/'))).text();

		expect(html).toContain('/linear/activity');
		expect(html).toContain('/slack');
		expect(html).not.toMatch(/crsr_|lin_oauth_|SECRET.*=/);
	});

	it('answers HEAD with no body', async () => {
		const response = await root.fetch(new Request('https://proxy.example/', { method: 'HEAD' }));
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('');
	});

	it('404s anything that is not a read', async () => {
		const response = await root.fetch(new Request('https://proxy.example/', { method: 'POST' }));
		expect(response.status).toBe(404);
	});
});

describe('secret redaction', () => {
	it('scrubs token-shaped strings out of anything logged', async () => {
		const { handleLinearActivityRequest, resetAppTokenCache } = await import('../api/linear-activity');
		const logged: string[] = [];
		vi.spyOn(console, 'log').mockImplementation((line: string) => void logged.push(line));
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify({ access_token: 'app_token_not_real', expires_in: 10 }), { status: 200 })),
		);

		await handleLinearActivityRequest(
			new Request('https://proxy.example/linear/activity', {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: 'Bearer relay_secret_not_real' },
				body: JSON.stringify({ agentSessionId: 's1', type: 'response', body: 'oops lin_oauth_deadbeefcafe1234 and crsr_abcdefghijkl' }),
			}),
			{
				LINEAR_CLIENT_ID: 'x',
				LINEAR_CLIENT_SECRET: 'y',
				LINEAR_ACTIVITY_SECRET: 'relay_secret_not_real',
				LOG_PAYLOADS: '1',
			},
		);

		const all = logged.join('\n');
		expect(all).toContain('<redacted>');
		expect(all).not.toContain('lin_oauth_deadbeefcafe1234');
		expect(all).not.toContain('crsr_abcdefghijkl');
		resetAppTokenCache();
	});

	it('logs no body at all unless LOG_PAYLOADS opts in', async () => {
		const { handleLinearCommentRequest } = await import('../api/linear-comment');
		const logged: string[] = [];
		vi.spyOn(console, 'log').mockImplementation((line: string) => void logged.push(line));
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('{}', { status: 200 })),
		);

		await handleLinearCommentRequest(
			new Request('https://proxy.example/linear/comment', {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: 'Bearer s' },
				body: JSON.stringify({ issueId: 'i1', body: 'confidential issue text' }),
			}),
			{ LINEAR_CLIENT_ID: 'x', LINEAR_CLIENT_SECRET: 'y', LINEAR_ACTIVITY_SECRET: 's' },
		);

		expect(logged.join('\n')).not.toContain('confidential issue text');
	});
});
