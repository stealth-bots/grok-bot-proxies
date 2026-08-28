import { handleRequest } from '../api/index';
import { handleLinearRequest } from '../api/linear';

export { handleRequest, verifySlackSignature, type SlackEnv } from '../api/index';
export { handleLinearRequest, verifyLinearSignature, type LinearEnv } from '../api/linear';

function isLinearPath(request: Request): boolean {
	const { pathname } = new URL(request.url);
	return pathname === '/linear' || pathname === '/api/webhooks/linear' || pathname === '/api/linear';
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (isLinearPath(request)) {
			return handleLinearRequest(request, env);
		}
		return handleRequest(request, env);
	},
};
