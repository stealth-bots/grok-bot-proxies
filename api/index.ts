import { handleRequest, type SlackEnv } from '../src/index';

function envFromProcess(): SlackEnv {
	return {
		CURSOR_WEBHOOK_URL: process.env.CURSOR_WEBHOOK_URL,
		CURSOR_WEBHOOK_KEY: process.env.CURSOR_WEBHOOK_KEY,
		SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET,
	};
}

export function GET(request: Request): Promise<Response> {
	return handleRequest(request, envFromProcess());
}

export function POST(request: Request): Promise<Response> {
	return handleRequest(request, envFromProcess());
}

export function HEAD(request: Request): Promise<Response> {
	return handleRequest(request, envFromProcess());
}

export default {
	async fetch(request: Request): Promise<Response> {
		return handleRequest(request, envFromProcess());
	},
};
