import { describe, expect, it } from 'vitest';
import root from '../api/index';

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
