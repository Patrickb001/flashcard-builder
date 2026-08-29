import { useCallback, useEffect, useRef, useState } from 'react';
import AiSettingsPanel from './AiSettingsPanel';
import type { AiSettings } from '../lib/aiGenerator';
import { loadAiSettings } from '../lib/aiGenerator';
import type { DocumentSection } from '../lib/documentModel';
import { extractPdfSections } from '../lib/pdfParser';
import { extractPptxSections } from '../lib/pptxParser';
import { extractMarkdownSections } from '../lib/markdownParser';

interface Props {
  onParsed: (
    sections: DocumentSection[],
    fileName: string,
    sourceType: 'pdf' | 'pptx' | 'md',
    ai: AiSettings
  ) => void;
  onCancel: () => void;
}

type Status = 'idle' | 'parsing' | 'error';

export default function Uploader({ onParsed, onCancel }: Props) {
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [ai, setAi] = useState<AiSettings>({ mode: 'off' });
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setAi(loadAiSettings());
  }, []);

  const handleFile = useCallback(
    async (file: File) => {
      const lowerName = file.name.toLowerCase();
      const isPdf = lowerName.endsWith('.pdf') || file.type === 'application/pdf';
      const isPptx =
        lowerName.endsWith('.pptx') ||
        file.type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
      // Markdown is matched on extension alone: browsers report .md as
      // text/markdown, text/plain or nothing at all depending on the platform.
      const isMarkdown = /\.(md|markdown|mdown|mkd)$/.test(lowerName);

      if (!isPdf && !isPptx && !isMarkdown) {
        setError('Please choose a .pdf, .pptx or .md file.');
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
            : await extractMarkdownSections(file);
        if (sections.length === 0) {
          setError(
            isMarkdown
              ? "That file looks empty — there was no text to turn into cards."
              : "Couldn't find any text in that file. If it's a scanned/image-only PDF, this app can't read it yet."
          );
          setStatus('error');
          return;
        }
        onParsed(sections, file.name, isPdf ? 'pdf' : isPptx ? 'pptx' : 'md', ai);
      } catch (err) {
        console.error(err);
        setError('Something went wrong while reading that file. Please try another one.');
        setStatus('error');
      }
    },
    [onParsed, ai]
  );

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
        Drop in a text-based PDF, a PDF exported from a slide deck, a native .pptx file, or a Markdown
        file of notes. We'll pull out the content and draft flashcards for you to check over next.
      </p>

      <div
        className={`dropzone ${isDragging ? 'dragging' : ''} ${status === 'parsing' ? 'busy' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={onDrop}
        onClick={() => status !== 'parsing' && inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.pptx,.md,.markdown,.mdown,.mkd,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/markdown"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
            e.target.value = '';
          }}
        />
        {status === 'parsing' ? (
          <>
            <div className="chalk-spinner" aria-hidden="true" />
            <p>Reading through the pages…</p>
          </>
        ) : (
          <>
            <div className="dropzone-icon" aria-hidden="true">
              ⤒
            </div>
            <p className="dropzone-label">Drop a .pdf, .pptx or .md here, or click to browse</p>
            <p className="muted small">Everything is parsed locally in your browser — nothing is uploaded anywhere.</p>
          </>
        )}
      </div>

      <div className="ai-section">
        <p className="eyebrow">How should cards be drafted?</p>
        <AiSettingsPanel settings={ai} onChange={setAi} />
      </div>

      {error && <p className="error-text">{error}</p>}

      <div className="form-actions">
        <button className="ghost-btn" onClick={onCancel} disabled={status === 'parsing'}>
          Cancel
        </button>
      </div>
    </div>
  );
}
