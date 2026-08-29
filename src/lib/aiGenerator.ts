import type { DocumentSection } from './documentModel';
import type { CandidateCard, CardCode, CardImage } from '../types';
import { CARD_SYSTEM_PROMPT, parseCardsResponse } from './cardPrompt';
import { dedupeCards, isUsableCard } from './cardValidation';
import { generateCandidates } from './flashcardGenerator';

/**
 * AI drafting. Two transports:
 *
 *  - "hosted": POST to /api/generate, a serverless function that holds the API
 *    key server-side. This is what visitors to a deployed site use, so nobody
 *    needs a key of their own.
 *  - "byok":   call the Anthropic API directly from the browser with a key the
 *    user pasted. Useful when running locally with no backend.
 *
 * Either way the model receives the structured blocks, never raw page text.
 */

export type AiMode = 'off' | 'hosted' | 'byok';

const SETTINGS_KEY = 'flashcard-forge:ai';
/** Sections per request. Small batches keep responses well within limits. */
const BATCH_SIZE = 4;

export interface AiSettings {
  mode: AiMode;
  apiKey?: string;
}

export function loadAiSettings(): AiSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { mode: 'off' };
    const parsed = JSON.parse(raw) as AiSettings;
    return { mode: parsed.mode ?? 'off', apiKey: parsed.apiKey };
  } catch {
    return { mode: 'off' };
  }
}

export function saveAiSettings(settings: AiSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage can be unavailable in private browsing; drafting still works.
  }
}

/**
 * The snippets and diagrams a batch offers the model, by id.
 *
 * Ids run across the whole batch rather than per section: the model answers for
 * the batch as a whole, and two sections in it would otherwise both claim "c1".
 */
interface AssetTable {
  code: Map<string, CardCode>;
  images: Map<string, CardImage>;
}

/**
 * Compact JSON payload for one batch — structure preserved, noise dropped.
 *
 * Snippets and images go over with an id beside them. The model attaches one to
 * a card by naming its id and the real content is put back here afterwards, so
 * a program is never routed through the model's own output — where a single
 * typo would land in the one part of a card that has to be exact, and where an
 * image address would simply be invented.
 */
function serializeBatch(sections: DocumentSection[]): { payload: unknown[]; assets: AssetTable } {
  const assets: AssetTable = { code: new Map(), images: new Map() };

  const payload = sections.map((section) => ({
    source: section.label,
    title: section.title ?? null,
    blocks: section.blocks.map((b) => {
      switch (b.kind) {
        case 'heading':
          return { type: 'heading', level: b.level, text: b.text };
        case 'paragraph':
          return { type: 'paragraph', label: b.heading ?? null, text: b.text };
        case 'list':
          return { type: 'list', label: b.heading ?? null, items: b.items };
        case 'table':
          return { type: 'table', headers: b.headers, rows: b.rows };
        case 'code': {
          const id = `c${assets.code.size + 1}`;
          assets.code.set(id, { text: b.text, language: b.language });
          return {
            type: 'code',
            id,
            language: b.language ?? null,
            label: b.heading ?? null,
            text: b.text,
            output: b.output ?? null,
            alsoIn: b.alsoIn?.length ? b.alsoIn : null,
          };
        }
        case 'image': {
          const id = `i${assets.images.size + 1}`;
          assets.images.set(id, { src: b.src, alt: b.alt });
          // The address is withheld on purpose: it is of no use to the model
          // and every byte of it would be spent for nothing.
          return {
            type: 'image',
            id,
            label: b.heading ?? null,
            alt: b.alt ?? null,
            caption: b.caption ?? null,
          };
        }
      }
    }),
  }));

  return { payload, assets };
}

async function callHosted(payload: unknown): Promise<string> {
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sections: payload }),
  });
  if (res.status === 404) {
    throw new Error(
      'The /api/generate endpoint was not found. Start the app with `npm run dev` from the project root so the dev server serves it.'
    );
  }
  if (!res.ok) {
    let detail = await res.text().catch(() => '');
    try {
      const parsed = JSON.parse(detail);
      detail = [parsed.error, parsed.detail].filter(Boolean).join(' — ');
    } catch {
      // Keep the raw body when it is not JSON.
    }
    throw new Error(detail || `Drafting service returned ${res.status}.`);
  }
  const data = await res.json();
  return typeof data.text === 'string' ? data.text : '';
}

async function callDirect(payload: unknown, apiKey: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      // Required for browser-originated calls.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 4000,
      system: CARD_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Anthropic API returned ${res.status}. ${detail}`.trim());
  }

  const data = await res.json();
  return (data.content ?? [])
    .map((part: { type: string; text?: string }) => (part.type === 'text' ? part.text ?? '' : ''))
    .join('\n');
}

export interface AiProgress {
  done: number;
  total: number;
}

/**
 * Drafts cards with the model, batch by batch. Any batch that fails falls back
 * to the rule-based generator for those sections, so a network problem degrades
 * the deck rather than emptying it.
 */
export async function generateCandidatesWithAi(
  sections: DocumentSection[],
  settings: AiSettings,
  onProgress?: (p: AiProgress) => void
): Promise<{
  cards: CandidateCard[];
  failedBatches: number;
  totalBatches: number;
  firstError: string | null;
}> {
  // Batches never span two source documents: every card in a batch is
  // attributed to the batch's first section, so a mixed batch would file
  // half its cards under the wrong page.
  const batches: DocumentSection[][] = [];
  for (const section of sections) {
    const current = batches[batches.length - 1];
    const sameSource = current && current[0].group === section.group;
    if (current && sameSource && current.length < BATCH_SIZE) current.push(section);
    else batches.push([section]);
  }

  const all: CandidateCard[] = [];
  let failedBatches = 0;
  let firstError: string | null = null;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const { payload, assets } = serializeBatch(batch);

    try {
      const text =
        settings.mode === 'byok' && settings.apiKey
          ? await callDirect(payload, settings.apiKey)
          : await callHosted(payload);

      const parsed = parseCardsResponse(text);
      if (parsed.length === 0) throw new Error('No cards returned');

      const label = batch[0].label;
      for (const card of parsed) {
        all.push({
          front: card.front,
          back: card.back,
          context: card.context || batch[0].title,
          // Cards are attributed to the batch's first section; the model is not
          // asked to echo per-card page numbers it could get wrong.
          sourceLabel: label,
          // An id the model invented resolves to nothing and is dropped, which
          // is the whole point of handing over ids rather than content.
          frontCode: card.frontCode ? assets.code.get(card.frontCode) : undefined,
          backCode: card.backCode ? assets.code.get(card.backCode) : undefined,
          image: card.image ? assets.images.get(card.image) : undefined,
          include: true,
        });
      }
    } catch (err) {
      console.error('AI batch failed, falling back to rules:', err);
      failedBatches += 1;
      if (!firstError) firstError = err instanceof Error ? err.message : String(err);
      all.push(...generateCandidates(batch));
    }

    onProgress?.({ done: i + 1, total: batches.length });
  }

  return {
    cards: dedupeCards(all.filter(isUsableCard)),
    failedBatches,
    totalBatches: batches.length,
    firstError,
  };
}
