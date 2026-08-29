import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { CARD_SYSTEM_PROMPT } from './src/lib/cardPrompt';
import { QUIZ_SYSTEM_PROMPT } from './src/lib/quizPrompt';
import { fetchPageHtml, PageFetchError } from './src/lib/fetchPage';

/**
 * The prompt each task is answered with, mirroring the Netlify function.
 *
 * A Map rather than an object literal, for the same reason it is one there: a
 * client-supplied "__proto__" indexes an object literal to something truthy.
 */
/**
 * Response ceiling per task.
 *
 * Quiz questions cost far more output than cards — five strings each rather
 * than two — and at 4000 a full batch was coming back truncated mid-JSON, so
 * the client silently lost the tail of every large batch. The client cannot
 * raise this: it is fixed here, deliberately, so a pasted key cannot run up an
 * unbounded bill.
 */
const MAX_TOKENS: Record<string, number> = { cards: 4000, quiz: 8000 };

const PROMPTS = new Map<string, string>([
  ['cards', CARD_SYSTEM_PROMPT],
  ['quiz', QUIZ_SYSTEM_PROMPT],
]);

/**
 * Serves /api/generate during `npm run dev`.
 *
 * In production this endpoint is the Netlify function. Reimplementing it here
 * means local development needs no extra CLI, while keeping the API key where
 * it belongs: in the Node process, never in the browser.
 */
function apiDevServer(env: Record<string, string>): Plugin {
  return {
    name: 'flashcard-forge-api-dev',
    configureServer(server) {
      server.middlewares.use('/api/generate', async (req, res) => {
        const send = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(body));
        };

        if (req.method !== 'POST') return send(405, { error: 'Method not allowed' });

        const apiKey = env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
          return send(500, {
            error:
              'ANTHROPIC_API_KEY is not set. Add it to a .env file in the project root, then restart the dev server.',
          });
        }

        let raw = '';
        for await (const chunk of req) raw += chunk;

        let sections: unknown;
        let task: unknown;
        try {
          ({ sections, task } = JSON.parse(raw));
        } catch {
          return send(400, { error: 'Invalid JSON body.' });
        }
        if (!Array.isArray(sections) || sections.length === 0) {
          return send(400, { error: 'Expected a non-empty "sections" array.' });
        }

        const taskName = typeof task === 'string' && task ? task : 'cards';
        const systemPrompt = PROMPTS.get(taskName);
        if (!systemPrompt) return send(400, { error: 'Unknown task.' });

        const payload = JSON.stringify(sections);
        // Production enforces this; without it here, an oversized deck works
        // locally and fails only once deployed.
        if (payload.length > 120_000) return send(413, { error: 'Payload too large.' });

        try {
          const upstream = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model: env.ANTHROPIC_MODEL || 'claude-sonnet-5',
              max_tokens: MAX_TOKENS[taskName] ?? MAX_TOKENS.cards,
              system: systemPrompt,
              messages: [{ role: 'user', content: payload }],
            }),
          });

          if (!upstream.ok) {
            const detail = await upstream.text().catch(() => '');
            // Logged to the terminal so the cause is visible without DevTools.
            console.error(`[api/generate] Anthropic ${upstream.status}: ${detail.slice(0, 400)}`);
            return send(502, {
              error: `Anthropic returned ${upstream.status}`,
              detail: detail.slice(0, 500),
            });
          }

          const data = await upstream.json();
          const text = (data.content ?? [])
            .map((p: { type: string; text?: string }) => (p.type === 'text' ? p.text ?? '' : ''))
            .join('\n');
          return send(200, { text, stopReason: data.stop_reason ?? null });
        } catch (err) {
          console.error('[api/generate] request failed:', err);
          return send(502, { error: 'Request to the model failed.' });
        }
      });
    },
  };
}

/**
 * Serves /api/fetch-page during `npm run dev`.
 *
 * The browser cannot read another site's HTML directly, so this reads it
 * server-side. In production the Netlify function does the same job. Both call
 * the same guarded fetcher — see src/lib/fetchPage.ts for why that matters.
 */
function pageFetchDevServer(): Plugin {
  return {
    name: 'flashcard-forge-fetch-dev',
    configureServer(server) {
      server.middlewares.use('/api/fetch-page', async (req, res) => {
        const send = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(body));
        };

        if (req.method !== 'POST') return send(405, { error: 'Method not allowed' });

        let raw = '';
        for await (const chunk of req) raw += chunk;

        let url: unknown;
        try {
          ({ url } = JSON.parse(raw));
        } catch {
          return send(400, { error: 'Invalid JSON body.' });
        }
        if (typeof url !== 'string' || !url.trim()) {
          return send(400, { error: 'Expected a "url" string.' });
        }

        try {
          const page = await fetchPageHtml(url);
          return send(200, page);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Could not read that page.';
          const status = err instanceof PageFetchError ? err.status : 502;
          console.error('[api/fetch-page]', message);
          return send(status, { error: message });
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Third argument '' loads every variable, not just VITE_-prefixed ones. These
  // stay server-side; nothing here is exposed to client code.
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [react(), apiDevServer(env), pageFetchDevServer()],
    optimizeDeps: { exclude: ['pdfjs-dist'] },
    worker: { format: 'es' },
  };
});
