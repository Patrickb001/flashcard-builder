import { useCallback, useEffect, useRef, useState } from 'react';
import AiSettingsPanel from './AiSettingsPanel';
import type { AiSettings } from '../lib/aiGenerator';
import { loadAiSettings } from '../lib/aiGenerator';
import type { DocumentSection } from '../lib/documentModel';
import { extractPdfSections } from '../lib/pdfParser';
import { extractPptxSections } from '../lib/pptxParser';
import { extractMarkdownSections } from '../lib/markdownParser';
import { extractHtmlSections } from '../lib/htmlParser';
import { fetchPageSections } from '../lib/pageSource';

export type SourceType = 'pdf' | 'pptx' | 'md' | 'html';

interface Props {
  onParsed: (
    sections: DocumentSection[],
    fileName: string,
    sourceType: SourceType,
    ai: AiSettings
  ) => void;
  onCancel: () => void;
}

type Status = 'idle' | 'parsing' | 'fetching' | 'error';

export default function Uploader({ onParsed, onCancel }: Props) {
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [ai, setAi] = useState<AiSettings>({ mode: 'off' });
  const [url, setUrl] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setAi(loadAiSettings());
  }, []);

  const busy = status === 'parsing' || status === 'fetching';

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

  const handleUrl = useCallback(async () => {
    const trimmed = url.trim();
    if (!trimmed) return;

    setStatus('fetching');
    setError(null);
    try {
      // A bare "react.dev/learn" is what people paste; assume https.
      const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
      const { sections, name } = await fetchPageSections(withScheme);
      if (sections.length === 0) {
        setError(
          "That page had no readable article text. Pages that build themselves entirely in the browser can't be read this way."
        );
        setStatus('error');
        return;
      }
      onParsed(sections, name, 'html', ai);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that page.');
      setStatus('error');
    }
  }, [url, onParsed, ai]);

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
            <p>{status === 'fetching' ? 'Reading that page…' : 'Reading through the pages…'}</p>
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
        <p className="eyebrow">Or study a web page</p>
        <div className="url-row">
          <input
            type="url"
            inputMode="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleUrl();
            }}
            placeholder="https://18.react.dev/learn/state-a-components-memory"
            aria-label="Web page address"
            disabled={busy}
          />
          <button className="ghost-btn" onClick={handleUrl} disabled={busy || !url.trim()}>
            {status === 'fetching' ? 'Reading…' : 'Read page'}
          </button>
        </div>
        <p className="muted small">
          The page is fetched by this app's own server so your browser is allowed to read it — only the
          address leaves your machine, and the text is turned into cards locally.
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
