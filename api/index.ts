const TEXT_PLAIN = 'text/plain; charset=utf-8';

function health(method: string): Response {
	return new Response(method === 'HEAD' ? null : 'ok', {
		status: 200,
		headers: { 'content-type': TEXT_PLAIN },
	});
}

export function GET(): Response {
	return health('GET');
}

export function HEAD(): Response {
	return health('HEAD');
}

export function POST(): Response {
	return new Response('Not Found', { status: 404 });
}

export default {
	fetch(request: Request): Response {
		const method = request.method.toUpperCase();
		if (method === 'GET' || method === 'HEAD') {
			return health(method);
		}
		return new Response('Not Found', { status: 404 });
	},
};
