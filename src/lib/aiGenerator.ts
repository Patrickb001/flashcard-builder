import type { DocumentSection } from './documentModel';
import type { CandidateCard, CardCode, CardImage } from '../types';
import { parseCardsResponse } from './cardPrompt';
import { callModel } from './aiTransport';
import { runBatches, type BatchProgress } from './batchRunner';
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

/** The same shape question writing reports; one definition, two features. */
export type AiProgress = BatchProgress;

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

  const outcome = await runBatches(
    batches,
    async (batch) => {
      const { payload, assets } = serializeBatch(batch);
      const { text } = await callModel('cards', payload, settings);
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
    },
    {
      onProgress,
      // A batch the model could not draft falls back to the rule-based
      // generator here, at the point it failed, so the deck keeps its order.
      onFailure: (batch, err) => {
        console.error('AI batch failed, falling back to rules:', err);
        all.push(...generateCandidates(batch));
      },
    }
  );

  return {
    cards: dedupeCards(all.filter(isUsableCard)),
    failedBatches: outcome.failedBatches,
    totalBatches: batches.length,
    firstError: outcome.firstError,
  };
}
