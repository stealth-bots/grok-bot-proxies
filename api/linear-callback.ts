const TEXT_PLAIN = 'text/plain; charset=utf-8';

const IDLE_TEXT = [
	'Linear OAuth callback.',
	'',
	'No authorization code in this request. Start the install from Linear and you will land back here with one.',
].join('\n');

export function GET(request: Request): Response {
	return handleLinearCallbackRequest(request);
}

export function HEAD(request: Request): Response {
	return handleLinearCallbackRequest(request);
}

export default {
	fetch(request: Request): Response {
		return handleLinearCallbackRequest(request);
	},
};

export function handleLinearCallbackRequest(request: Request): Response {
	const method = request.method.toUpperCase();

	if (method !== 'GET' && method !== 'HEAD') {
		return new Response('Method Not Allowed', {
			status: 405,
			headers: { allow: 'GET, HEAD' },
		});
	}

	const params = new URL(request.url).searchParams;
	const error = params.get('error');
	const code = params.get('code');

	const body = error ? errorText(error, params.get('error_description')) : code ? successText(code) : IDLE_TEXT;

	return new Response(method === 'HEAD' ? null : body, {
		status: error ? 400 : 200,
		headers: {
			'content-type': TEXT_PLAIN,
			// Query params are echoed back. text/plain plus nosniff keeps them inert
			// rather than something a browser could be talked into parsing as markup.
			'x-content-type-options': 'nosniff',
			// The code is single-use and short-lived; keep it out of shared caches and Referer.
			'cache-control': 'no-store',
			'referrer-policy': 'no-referrer',
		},
	});
}

function successText(code: string): string {
	return [
		'Linear app installed.',
		'',
		'You can close this tab.',
		'',
		`code: ${code}`,
		'',
		'That code is only needed for the authorization_code grant. The app actor token used to',
		'post agent activities comes from client_credentials, which does not use it.',
	].join('\n');
}

function errorText(error: string, description: string | null): string {
	return [
		'Linear did not complete the install.',
		'',
		`error: ${error}`,
		...(description ? [`description: ${description}`] : []),
		'',
		'Re-run the authorize URL. Check that redirect_uri matches one registered on the app exactly,',
		'that actor=app is present, and that you are signed in as a workspace admin.',
	].join('\n');
}
