import { waitUntil } from '@vercel/functions';
import { handleLinearRequest, type LinearEnv } from '../src/linear';

export { handleLinearRequest, verifyLinearSignature, type LinearEnv } from '../src/linear';

function envFromProcess(): LinearEnv {
	return {
		LINEAR_CURSOR_WEBHOOK_URL: process.env.LINEAR_CURSOR_WEBHOOK_URL,
		LINEAR_CURSOR_WEBHOOK_KEY: process.env.LINEAR_CURSOR_WEBHOOK_KEY,
		LINEAR_WEBHOOK_SECRET: process.env.LINEAR_WEBHOOK_SECRET,
	};
}

export function GET(request: Request): Promise<Response> {
	return handleLinearRequest(request, envFromProcess());
}

export function POST(request: Request): Promise<Response> {
	return handleLinearRequest(request, envFromProcess(), waitUntil);
}

export function HEAD(request: Request): Promise<Response> {
	return handleLinearRequest(request, envFromProcess());
}

export default {
	fetch(request: Request): Promise<Response> {
		return handleLinearRequest(request, envFromProcess(), waitUntil);
	},
};
