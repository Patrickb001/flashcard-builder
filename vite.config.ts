import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createRateLimiter, decodeBody, runEndpoint, type HandlerResult } from './src/server/endpoint';
import { handleGenerate } from './src/server/generateHandler';
import { handleFetchPage } from './src/server/fetchPageHandler';

/**
 * The API endpoints, during `npm run dev`.
 *
 * In production these are Netlify functions. Serving them here means local
 * development needs no extra CLI, while keeping the API key where it belongs:
 * in the Node process, never in the browser.
 *
 * The logic itself lives in src/server; this file and the Netlify functions are
 * both thin adapters over it, so neither deployment can drift from the other.
 */

/** Collects a Connect request body; decodeBody does the UTF-8 work. */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) chunks.push(chunk as Uint8Array);
  return decodeBody(chunks);
}

function respond(res: ServerResponse, { status, body }: HandlerResult): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

/** Serves one endpoint at `route`, with the same front half production uses. */
function devEndpoint(
  name: string,
  route: string,
  perMinute: number,
  tooManyMessage: string,
  handle: (body: unknown) => Promise<HandlerResult>
): Plugin {
  const rateLimited = createRateLimiter(perMinute);

  return {
    name,
    configureServer(server) {
      server.middlewares.use(route, async (req, res) => {
        const result = await runEndpoint(
          {
            method: req.method,
            address: req.socket.remoteAddress ?? 'unknown',
            rawBody: await readBody(req),
          },
          { rateLimited, tooManyMessage, handle }
        );
        respond(res, result);
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Third argument '' loads every variable, not just VITE_-prefixed ones. These
  // stay server-side; nothing here is exposed to client code.
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [
      react(),
      devEndpoint(
        'flashcard-forge-api-dev',
        '/api/generate',
        20,
        'Too many requests. Try again shortly.',
        (body) =>
          handleGenerate(body, {
            apiKey: env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY,
            model: env.ANTHROPIC_MODEL,
            onError: (message) => console.error('[api/generate]', message),
          })
      ),
      devEndpoint(
        'flashcard-forge-fetch-dev',
        '/api/fetch-page',
        30,
        'Too many pages requested. Try again shortly.',
        (body) =>
          handleFetchPage(body, {
            onError: (message) => console.error('[api/fetch-page]', message),
          })
      ),
    ],
    optimizeDeps: { exclude: ['pdfjs-dist'] },
    worker: { format: 'es' },
  };
});
