import { useState } from 'react';
import type { AiSettings } from '../lib/aiGenerator';
import { saveAiSettings } from '../lib/aiGenerator';

interface Props {
  settings: AiSettings;
  onChange: (settings: AiSettings) => void;
}

/**
 * Chooses how cards get drafted. Rules run locally and free; AI drafting either
 * goes through the deployed serverless function or, when running without a
 * backend, directly from the browser with the user's own key.
 */
export default function AiSettingsPanel({ settings, onChange }: Props) {
  const [showKey, setShowKey] = useState(false);

  const update = (next: AiSettings) => {
    saveAiSettings(next);
    onChange(next);
  };

  return (
    <div className="ai-panel">
      <div className="ai-modes">
        <button
          className={`mode-chip ${settings.mode === 'off' ? 'active' : ''}`}
          onClick={() => update({ ...settings, mode: 'off' })}
        >
          Rules only
        </button>
        <button
          className={`mode-chip ${settings.mode === 'hosted' ? 'active' : ''}`}
          onClick={() => update({ ...settings, mode: 'hosted' })}
        >
          AI drafting
        </button>
        <button
          className={`mode-chip ${settings.mode === 'byok' ? 'active' : ''}`}
          onClick={() => update({ ...settings, mode: 'byok' })}
        >
          AI with my own key
        </button>
      </div>

      {settings.mode === 'off' && (
        <p className="muted small">
          Cards are drafted locally with pattern rules. Instant, private, and free — best on slide
          decks and tables.
        </p>
      )}

      {settings.mode === 'hosted' && (
        <p className="muted small">
          Cards are drafted by Claude through this site's own server. Slower, but much better on
          prose documents. Requires the site to be deployed with an API key configured.
        </p>
      )}

      {settings.mode === 'byok' && (
        <div className="byok">
          <p className="muted small">
            Your key is stored in this browser only and sent straight to Anthropic. Anyone who can
            run scripts on this page could read it, so use a key with a low spend limit and avoid
            this mode on a shared machine.
          </p>
          <div className="key-row">
            <input
              type={showKey ? 'text' : 'password'}
              value={settings.apiKey ?? ''}
              placeholder="sk-ant-..."
              onChange={(e) => update({ ...settings, apiKey: e.target.value })}
              autoComplete="off"
              spellCheck={false}
            />
            <button className="ghost-btn small" onClick={() => setShowKey((v) => !v)}>
              {showKey ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
