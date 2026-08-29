import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AiSettingsPanel from './AiSettingsPanel';
import type { AiSettings } from '../lib/aiGenerator';
import { loadAiSettings } from '../lib/aiGenerator';
import type { DocumentSection } from '../lib/documentModel';
import { extractPdfSections } from '../lib/pdfParser';
import { extractPptxSections } from '../lib/pptxParser';
import { extractMarkdownSections } from '../lib/markdownParser';
import { extractHtmlSections } from '../lib/htmlParser';
import type { PageProgress } from '../lib/pageSource';
import { MAX_PAGES, deckNameForUrl, describeFailures, fetchPagesSections, parseUrlList } from '../lib/pageSource';

export type SourceType = 'pdf' | 'pptx' | 'md' | 'html';

interface Props {
  onParsed: (
    sections: DocumentSection[],
    fileName: string,
    sourceType: SourceType,
    ai: AiSettings,
    /** Shown on the review screen when some sources were skipped. */
    notice?: string
  ) => void;
  onCancel: () => void;
}

type Status = 'idle' | 'parsing' | 'fetching' | 'error';

export default function Uploader({ onParsed, onCancel }: Props) {
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [ai, setAi] = useState<AiSettings>({ mode: 'off' });
  const [urlText, setUrlText] = useState('');
  const [progress, setProgress] = useState<PageProgress | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setAi(loadAiSettings());
  }, []);

  const busy = status === 'parsing' || status === 'fetching';
  const pendingUrls = useMemo(() => parseUrlList(urlText), [urlText]);

  const handleFile = useCallback(
    async (file: File) => {
      const lowerName = file.name.toLowerCase();
      const isPdf = lowerName.endsWith('.pdf') || file.type === 'application/pdf';
      const isPptx =
        lowerName.endsWith('.pptx') ||
        file.type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
      // Text formats are matched on extension alone: browsers report .md and
      // saved pages as text/plain, text/markdown or nothing, by platform.
      const isMarkdown = /\.(md|markdown|mdown|mkd)$/.test(lowerName);
      const isHtml = /\.(html?|xhtml)$/.test(lowerName);

      if (!isPdf && !isPptx && !isMarkdown && !isHtml) {
        setError('Please choose a .pdf, .pptx, .md or .html file.');
        setStatus('error');
        return;
      }

      setStatus('parsing');
      setError(null);
      try {
        const sections = isPdf
          ? await extractPdfSections(file)
          : isPptx
            ? await extractPptxSections(file)
            : isMarkdown
              ? await extractMarkdownSections(file)
              : await extractHtmlSections(file);
        if (sections.length === 0) {
          setError(
            isPdf
              ? "Couldn't find any text in that file. If it's a scanned/image-only PDF, this app can't read it yet."
              : 'That file looks empty — there was no text to turn into cards.'
          );
          setStatus('error');
          return;
        }
        const sourceType: SourceType = isPdf ? 'pdf' : isPptx ? 'pptx' : isMarkdown ? 'md' : 'html';
        onParsed(sections, file.name, sourceType, ai);
      } catch (err) {
        console.error(err);
        setError('Something went wrong while reading that file. Please try another one.');
        setStatus('error');
      }
    },
    [onParsed, ai]
  );

  const handleUrls = useCallback(async () => {
    const urls = parseUrlList(urlText);
    if (urls.length === 0) return;

    setStatus('fetching');
    setError(null);
    setProgress({ done: 0, total: Math.min(urls.length, MAX_PAGES), url: urls[0] });

    try {
      const { sections, name, failures, pages } = await fetchPagesSections(urls, setProgress);

      if (sections.length === 0) {
        setProgress(null);
        setError(
          failures.length === 1
            ? failures[0].error
            : `None of those ${failures.length} pages could be read. ${failures
                .slice(0, 3)
                .map((f) => `${deckNameForUrl(f.url)} — ${f.error}`)
                .join('; ')}`
        );
        setStatus('error');
        return;
      }

      // Some pages read, some did not: the deck is still worth building, but
      // the gap has to be visible on the review screen rather than silent.
      onParsed(
        sections,
        name,
        'html',
        ai,
        failures.length > 0 ? describeFailures(failures, pages) : undefined
      );
    } catch (err) {
      setProgress(null);
      setError(err instanceof Error ? err.message : 'Could not read those pages.');
      setStatus('error');
    }
  }, [urlText, onParsed, ai]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  return (
    <div className="uploader">
      <p className="eyebrow">Step 1 of 2</p>
      <h1>Bring a document to class</h1>
      <p className="muted">
        Drop in a text-based PDF, a PDF exported from a slide deck, a native .pptx file, a Markdown
        file of notes, or a saved web page — or paste the address of a page you want to study. We'll
        pull out the content and draft flashcards for you to check over next.
      </p>

      <div
        className={`dropzone ${isDragging ? 'dragging' : ''} ${busy ? 'busy' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={onDrop}
        onClick={() => !busy && inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.pptx,.md,.markdown,.mdown,.mkd,.html,.htm,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/markdown,text/html"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
            e.target.value = '';
          }}
        />
        {busy ? (
          <>
            <div className="chalk-spinner" aria-hidden="true" />
            <p>{status === 'fetching' ? 'Reading those pages…' : 'Reading through the pages…'}</p>
          </>
        ) : (
          <>
            <div className="dropzone-icon" aria-hidden="true">
              ⤒
            </div>
            <p className="dropzone-label">Drop a .pdf, .pptx, .md or .html here, or click to browse</p>
            <p className="muted small">Everything is parsed locally in your browser — nothing is uploaded anywhere.</p>
          </>
        )}
      </div>

      <div className="url-section">
        <p className="eyebrow">Or study web pages</p>
        <textarea
          className="url-input"
          value={urlText}
          onChange={(e) => setUrlText(e.target.value)}
          onKeyDown={(e) => {
            // Enter belongs to the field — the list is multi-line. Ctrl or
            // Cmd with Enter is the shortcut for submitting it.
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              handleUrls();
            }
          }}
          rows={3}
          placeholder={'https://18.react.dev/learn/state-a-components-memory\nhttps://18.react.dev/learn/render-and-commit'}
          aria-label="Web page addresses, one per line"
          disabled={busy}
        />
        <div className="url-actions">
          <span className="muted small">
            {pendingUrls.length > 0
              ? `${pendingUrls.length} page${pendingUrls.length === 1 ? '' : 's'}${
                  pendingUrls.length > MAX_PAGES ? ` — only the first ${MAX_PAGES} will be read` : ''
                }`
              : 'One address per line — several pages become one deck.'}
          </span>
          <button className="ghost-btn" onClick={handleUrls} disabled={busy || pendingUrls.length === 0}>
            {status === 'fetching'
              ? `Reading ${Math.min((progress?.done ?? 0) + 1, progress?.total ?? 1)} of ${progress?.total ?? 1}…`
              : pendingUrls.length > 1
                ? `Read ${Math.min(pendingUrls.length, MAX_PAGES)} pages`
                : 'Read page'}
          </button>
        </div>
        <p className="muted small">
          Pages are fetched by this app's own server so your browser is allowed to read them — only the
          addresses leave your machine, and the text is turned into cards locally.
        </p>
      </div>

      <div className="ai-section">
        <p className="eyebrow">How should cards be drafted?</p>
        <AiSettingsPanel settings={ai} onChange={setAi} />
      </div>

      {error && <p className="error-text">{error}</p>}

      <div className="form-actions">
        <button className="ghost-btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}
