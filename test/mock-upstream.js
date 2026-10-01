// Preloaded only into the unit-test child server. No unit test may call a real
// provider; fake-token tests exercise an upstream 401 without external network.
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input instanceof Request ? input.url : input);
  const headers = new Headers(options.headers);
  if (url.href === 'https://chatgpt.com/backend-api/codex/responses' &&
      headers.get('authorization') === 'Bearer fake-token-for-testing') {
    return new Response(JSON.stringify({ error: { message: 'Invalid test access token' } }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }
  throw new Error('Unexpected upstream request in unit-test server');
};
