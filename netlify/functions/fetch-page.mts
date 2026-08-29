import type { Config, Context } from '@netlify/functions';
import { createRateLimiter, runEndpoint } from '../../src/server/endpoint';
import { handleFetchPage } from '../../src/server/fetchPageHandler';

/**
 * Netlify adapter for the page reader.
 *
 * The endpoint lives in src/server/fetchPageHandler.ts, shared with the dev
 * server. A deck can be built from up to ten pages at once, so the limit has to
 * sit above that or the last page of a legitimate batch is refused.
 */

const rateLimited = createRateLimiter(30);

export default async (req: Request, context: Context) => {
  const { status, body } = await runEndpoint(
    {
      method: req.method,
      address: context.ip ?? 'unknown',
      rawBody: await req.text().catch(() => ''),
    },
    {
      rateLimited,
      tooManyMessage: 'Too many pages requested. Try again shortly.',
      handle: (parsed) =>
        handleFetchPage(parsed, {
          onError: (message) => console.error('[api/fetch-page]', message),
        }),
    }
  );

  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const config: Config = {
  path: '/api/fetch-page',
};
