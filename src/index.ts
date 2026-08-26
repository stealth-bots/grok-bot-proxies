import { handleRequest } from '../api/index';

export { handleRequest, verifySlackSignature, type SlackEnv } from '../api/index';

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		return handleRequest(request, env);
	},
};
