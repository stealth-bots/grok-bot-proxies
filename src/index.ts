import { handleSlackRequest } from '../api/slack';
import { handleLinearRequest } from './linear';

export { handleLinearRequest, verifyLinearSignature, type LinearEnv } from './linear';
export { handleRequest, handleSlackRequest, verifySlackSignature, type SlackEnv } from '../api/slack';

const TEXT_PLAIN = 'text/plain; charset=utf-8';

function pathnameOf(request: Request): string {
	return new URL(request.url).pathname;
}

function isLinearPath(request: Request): boolean {
	const pathname = pathnameOf(request);
	return pathname === '/linear' || pathname === '/api/webhooks/linear' || pathname === '/api/linear';
}

function isSlackPath(request: Request): boolean {
	const pathname = pathnameOf(request);
	return pathname === '/slack' || pathname === '/api/webhooks/slack' || pathname === '/api/slack';
}

export default {
	async fetch(request: Request, env: Env, ctx?: { waitUntil(task: Promise<unknown>): void }): Promise<Response> {
		if (isLinearPath(request)) {
			return handleLinearRequest(request, env, ctx ? (task) => ctx.waitUntil(task) : undefined);
		}
		if (isSlackPath(request)) {
			return handleSlackRequest(request, env);
		}

		const method = request.method.toUpperCase();
		if ((method === 'GET' || method === 'HEAD') && pathnameOf(request) === '/') {
			return new Response(method === 'HEAD' ? null : 'ok', {
				status: 200,
				headers: { 'content-type': TEXT_PLAIN },
			});
		}
		return new Response('Not Found', { status: 404 });
	},
};
