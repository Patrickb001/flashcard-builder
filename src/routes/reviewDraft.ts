import type { DocumentSection } from '../lib/documentModel';
import type { AiSettings } from '../lib/aiGenerator';
import type { SourceType } from '../components/Uploader';

/**
 * A parsed document on its way to the review screen.
 *
 * The uploader produces this and the review screen consumes it. It is handed
 * over in history state rather than in the URL: a URL can hold a deck id, but
 * not a document's worth of parsed sections.
 *
 * History state does not survive a reload, which is why /review redirects to
 * /upload when it arrives empty. Persisting the draft so a reload resumes it is
 * the next phase; this type is what will be stored.
 */
export interface ReviewDraft {
  sections: DocumentSection[];
  fileName: string;
  sourceType: SourceType;
  ai: AiSettings;
  /** Set when some sources were skipped, e.g. a page that could not be read. */
  notice?: string;
}

/** Reads a draft out of history state, or null when there is nothing there. */
export function draftFromState(state: unknown): ReviewDraft | null {
  if (!state || typeof state !== 'object') return null;
  const draft = state as Partial<ReviewDraft>;
  if (!Array.isArray(draft.sections) || typeof draft.fileName !== 'string') return null;
  return draft as ReviewDraft;
}
