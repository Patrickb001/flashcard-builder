import http from 'node:http';
import { createRateLimiter, decodeBody, runEndpoint } from '../src/server/endpoint.ts';
import { handleGenerate } from '../src/server/generateHandler.ts';
import { handleFetchPage } from '../src/server/fetchPageHandler.ts';

/**
 * Exercises the shared endpoint code both deployments now run.
 *
 *   node --experimental-strip-types --import ./tools/register.mjs \
 *     tools/test-server.mjs
 *
 * The body test is the one that matters. The dev server used to build its
 * request body by appending each socket chunk to a string, which decodes every
 * chunk separately, so a multi-byte character split across a ~64KB boundary
 * became two U+FFFD replacement characters. Production used req.json() and was
 * unaffected, so an em-dash in a card was fine deployed and corrupt locally.
 */

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n         got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}

// --------------------------------------------------------------------------
console.log('\nBODY DECODING');

// An em-dash is three UTF-8 bytes. Place one so it straddles a 64KB boundary.
const CHUNK = 65536;
const text = 'a'.repeat(CHUNK - 1) + '—' + 'b'.repeat(100);
const bytes = new TextEncoder().encode(text);

const split = [];
for (let i = 0; i < bytes.length; i += CHUNK) split.push(bytes.subarray(i, i + CHUNK));
check('the em-dash really does straddle a chunk boundary', split.length > 1, true);

check('decodeBody round-trips it', decodeBody(split) === text, true);

// The old approach, for contrast: decode each chunk on its own.
let naive = '';
for (const chunk of split) naive += new TextDecoder('utf-8').decode(chunk);
check('appending each chunk corrupts it (the bug)', naive !== text, true);
check('and does so as U+FFFD', naive.includes('�'), true);

// --------------------------------------------------------------------------
console.log('\nSHARED FRONT HALF');

const never = () => false;
const okHandler = async (body) => ({ status: 200, body: { echoed: body } });

check(
  'GET is refused as JSON, not plain text',
  await runEndpoint({ method: 'GET', address: 'a', rawBody: '' }, { rateLimited: never, tooManyMessage: 'x', handle: okHandler }),
  { status: 405, body: { error: 'Method not allowed' } }
);

check(
  'a malformed body is a 400',
  await runEndpoint({ method: 'POST', address: 'a', rawBody: '{oops' }, { rateLimited: never, tooManyMessage: 'x', handle: okHandler }),
  { status: 400, body: { error: 'Invalid JSON body.' } }
);

check(
  'the throttle answers 429 with its own message',
  await runEndpoint({ method: 'POST', address: 'a', rawBody: '{}' }, { rateLimited: () => true, tooManyMessage: 'Too many.', handle: okHandler }),
  { status: 429, body: { error: 'Too many.' } }
);

const limiter = createRateLimiter(2);
check('under the limit', [limiter('ip1'), limiter('ip1')], [false, false]);
check('over the limit', limiter('ip1'), true);
check('a different address is unaffected', limiter('ip2'), false);

// --------------------------------------------------------------------------
console.log('\nHANDLERS');

check(
  'generate refuses an empty sections array',
  await handleGenerate({ sections: [], task: 'cards' }, { apiKey: 'k' }),
  { status: 400, body: { error: 'Expected a non-empty "sections" array.' } }
);

check(
  'generate refuses an unknown task',
  await handleGenerate({ sections: [1], task: 'nonsense' }, { apiKey: 'k' }),
  { status: 400, body: { error: 'Unknown task.' } }
);

check(
  'generate refuses a prototype-walking task name',
  await handleGenerate({ sections: [1], task: '__proto__' }, { apiKey: 'k' }),
  { status: 400, body: { error: 'Unknown task.' } }
);

check(
  'generate refuses an oversized payload',
  (await handleGenerate({ sections: ['x'.repeat(130_000)], task: 'cards' }, { apiKey: 'k' })).status,
  413
);

check(
  'generate reports a missing key rather than calling out',
  (await handleGenerate({ sections: [1], task: 'cards' }, { apiKey: undefined })).status,
  500
);

check(
  'fetch-page refuses a missing url',
  await handleFetchPage({}),
  { status: 400, body: { error: 'Expected a "url" string.' } }
);

const blocked = await handleFetchPage({ url: 'http://localhost:5201/probe' });
check('fetch-page still refuses loopback addresses', blocked.status !== 200, true);

// --------------------------------------------------------------------------
console.log('\nOVER A REAL SOCKET');

const rateLimited = createRateLimiter(100);
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const result = await runEndpoint(
    { method: req.method, address: 'test', rawBody: decodeBody(chunks) },
    { rateLimited, tooManyMessage: 'x', handle: okHandler }
  );
  res.statusCode = result.status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(result.body));
});

await new Promise((r) => server.listen(5202, r));

const sent = { note: text };
const response = await fetch('http://localhost:5202/', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(sent),
});
const returned = await response.json();
check('a >64KB body with a straddling em-dash survives the round trip', returned.echoed.note === text, true);
check('and the em-dash is still an em-dash', returned.echoed.note.includes('�'), false);

server.close();

console.log('');
if (failures) {
  console.log(`${failures} check(s) failed.`);
  process.exit(1);
}
console.log('All checks passed.');
