import { describe, expect, it } from 'vitest';
import { handleLinearCallbackRequest } from '../api/linear-callback';

function callback(query: string, init?: RequestInit): Request {
	return new Request(`https://proxy.example/linear/callback${query}`, init);
}

describe('GET /linear/callback', () => {
	it('confirms the install instead of 404ing the OAuth redirect', async () => {
		const response = handleLinearCallbackRequest(callback('?code=abc123&state=xyz'));

		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).toContain('Linear app installed.');
		expect(text).toContain('abc123');
	});

	it('serves reflected query params as inert text a browser cannot be talked into parsing', async () => {
		const response = handleLinearCallbackRequest(callback('?code=%3Cscript%3Ealert(1)%3C%2Fscript%3E'));

		expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
	});

	it('keeps the single-use code out of shared caches and Referer', async () => {
		const response = handleLinearCallbackRequest(callback('?code=abc123'));

		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('referrer-policy')).toBe('no-referrer');
	});

	it('reports an install Linear refused, with its reason', async () => {
		const response = handleLinearCallbackRequest(callback('?error=access_denied&error_description=User+denied'));

		expect(response.status).toBe(400);
		const text = await response.text();
		expect(text).toContain('access_denied');
		expect(text).toContain('User denied');
	});

	it('explains itself when opened directly with no params', async () => {
		const response = handleLinearCallbackRequest(callback(''));

		expect(response.status).toBe(200);
		expect(await response.text()).toContain('No authorization code');
	});

	it('answers HEAD with no body', async () => {
		const response = handleLinearCallbackRequest(callback('?code=abc123', { method: 'HEAD' }));

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('');
	});

	it('rejects methods an OAuth redirect never uses', async () => {
		const response = handleLinearCallbackRequest(callback('', { method: 'POST' }));

		expect(response.status).toBe(405);
		expect(response.headers.get('allow')).toBe('GET, HEAD');
	});
});
