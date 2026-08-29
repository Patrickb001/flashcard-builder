import type { Config, Context } from '@netlify/functions';
import { createRateLimiter, runEndpoint } from '../../src/server/endpoint';
import { handleGenerate } from '../../src/server/generateHandler';

/**
 * Netlify adapter for the card and question endpoint.
 *
 * The endpoint itself lives in src/server. All this file does is turn a Web
 * Request into the three things the shared runner needs, and turn the result
 * back into a Response. The dev server's adapter in vite.config.ts is the same
 * few lines against Connect, which is the point: the logic they used to keep
 * separate copies of had drifted apart in six ways.
 */

const rateLimited = createRateLimiter(20);

export default async (req: Request, context: Context) => {
  const { status, body } = await runEndpoint(
    {
      method: req.method,
      address: context.ip ?? 'unknown',
      rawBody: await req.text().catch(() => ''),
    },
    {
      rateLimited,
      tooManyMessage: 'Too many requests. Try again shortly.',
      handle: (parsed) =>
        handleGenerate(parsed, {
          apiKey: process.env.ANTHROPIC_API_KEY,
          model: process.env.ANTHROPIC_MODEL,
          onError: (message) => console.error('[api/generate]', message),
        }),
    }
  );

  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const config: Config = {
  path: '/api/generate',
};
