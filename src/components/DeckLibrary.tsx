import { useEffect, useMemo, useState } from 'react';
import type { Deck, Folder } from '../types';
import { createFolder, renameFolder } from '../db/db';
import { confirmAndDeleteDeck, confirmAndDeleteFolder } from '../lib/deckActions';
import {
  UNFILED,
  cleanFolderName,
  countDecksByFolder,
  filterDecks,
  folderErrorMessage,
  folderOf,
  sortDecks,
  sortFolders,
  type FolderFilter,
  type LibrarySort,
} from '../lib/deckFolders';
import { getStoredLibrarySort, storeLibrarySort } from '../lib/librarySort';
import ErrorNotice from './ui/ErrorNotice';

interface Props {
  /** Every saved deck, newest first. Loaded by the route, not by this screen. */
  decks: Deck[];
  /** Every folder, unordered. Sorted here, alongside the decks. */
  folders: Folder[];
  /** Which part of the shelf to show, already checked against `folders` by the route. */
  filter: FolderFilter;
  loading: boolean;
  /** Why the deck list could not be read, if it could not be. */
  error?: string | null;
  /** Starts a new deck, preselecting `folderId` on the review screen when given. */
  onNewDeck: (folderId?: string) => void;
  /** Changes which part of the shelf is shown. The route keeps it in the URL. */
  onSelectFolder: (filter: FolderFilter) => void;
  onStudy: (deckId: string) => void;
  onManage: (deckId: string) => void;
  /** Fired after a deck or folder changes, so the route can re-read both lists. */
  onLibraryChange: () => Promise<void>;
}

const SORT_OPTIONS: { value: LibrarySort; label: string }[] = [
  { value: 'newest', label: 'Newest' },
  { value: 'name', label: 'A–Z' },
];

/**
 * The deck shelf: a folder bar, a sort switch, and the decks the chosen folder
 * holds, with an empty state for a first visit.
 *
 * Presentational apart from the writes a shelf owns — deleting a deck, and
 * creating, renaming and deleting folders. The lists themselves are loaded and
 * owned by LibraryRoute, so nothing else in the app has to refresh them.
 */
export default function DeckLibrary({
  decks,
  folders,
  filter,
  loading,
  error,
  onNewDeck,
  onSelectFolder,
  onStudy,
  onManage,
  onLibraryChange,
}: Props) {
  const [actionError, setActionError] = useState<string | null>(null);
  // Read on the first render rather than in an effect: set afterwards, the
  // grid draws once in the wrong order before correcting itself.
  const [sort, setSort] = useState<LibrarySort>(getStoredLibrarySort);
  const [folderNameDraft, setFolderNameDraft] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderDraft, setNewFolderDraft] = useState('');

  const folderIds = useMemo(() => new Set(folders.map((folder) => folder.id)), [folders]);
  const folderNames = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder.name])),
    [folders]
  );
  const counts = useMemo(() => countDecksByFolder(decks, folders), [decks, folders]);
  const sortedFolders = useMemo(() => sortFolders(folders, sort), [folders, sort]);
  const visibleDecks = useMemo(
    () => sortDecks(filterDecks(decks, folders, filter), sort),
    [decks, folders, filter, sort]
  );
  const selectedFolder = folders.find((folder) => folder.id === filter) ?? null;

  // The folder name is a draft the reader edits, so it is re-seeded whenever a
  // different folder is opened or the open one is renamed.
  useEffect(() => {
    setFolderNameDraft(selectedFolder?.name ?? '');
  }, [selectedFolder?.id, selectedFolder?.name]);

  const changeSort = (next: LibrarySort) => {
    setSort(next);
    storeLibrarySort(next);
  };

  /**
   * Arrow keys move between the two sort options, as in any radio group.
   * Selection follows focus, which is what a radio group does natively.
   */
  const handleSortKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const next: LibrarySort = sort === 'newest' ? 'name' : 'newest';
    changeSort(next);
    e.currentTarget.parentElement
      ?.querySelector<HTMLButtonElement>(`[data-sort="${next}"]`)
      ?.focus();
  };

  /**
   * Deletes a deck from its card's delete button.
   *
   * The click is stopped from propagating because the whole card is itself a
   * button that opens the deck — without it, deleting would also navigate.
   */
  const handleDelete = async (e: React.MouseEvent, deckId: string, name: string) => {
    e.stopPropagation();
    try {
      setActionError(null);
      if (await confirmAndDeleteDeck(deckId, name)) await onLibraryChange();
    } catch (err) {
      console.error('[library] Deleting the deck failed:', err);
      setActionError(`"${name}" could not be deleted.`);
    }
  };

  /** Opens the inline "+ New folder" field. */
  const startNewFolder = () => {
    setActionError(null);
    setNewFolderDraft('');
    setCreatingFolder(true);
  };

  /** Closes the inline field without creating anything. */
  const cancelNewFolder = () => {
    setActionError(null);
    setCreatingFolder(false);
    setNewFolderDraft('');
  };

  /**
   * Creates the folder and opens it. Left open with its text on a failed
   * write (e.g. a duplicate name), so fixing it is a retry, not a restart.
   */
  const submitNewFolder = async () => {
    const cleaned = cleanFolderName(newFolderDraft);
    if (!cleaned) {
      cancelNewFolder();
      return;
    }
    try {
      setActionError(null);
      const folder = await createFolder(cleaned);
      setCreatingFolder(false);
      setNewFolderDraft('');
      // Refreshed first: until the route holds the new folder, its id would
      // not survive parseFolderFilter and the shelf would fall back to All.
      await onLibraryChange();
      onSelectFolder(folder.id);
    } catch (err) {
      console.error('[library] Creating the folder failed:', err);
      setActionError(folderErrorMessage(err, 'The folder could not be created.'));
    }
  };

  /** Saves a renamed folder on blur, restoring the old name if the write fails. */
  const commitFolderName = async () => {
    if (!selectedFolder) return;
    const cleaned = cleanFolderName(folderNameDraft);
    if (!cleaned || cleaned === selectedFolder.name) {
      setFolderNameDraft(selectedFolder.name);
      return;
    }
    try {
      setActionError(null);
      await renameFolder(selectedFolder.id, cleaned);
      await onLibraryChange();
    } catch (err) {
      console.error('[library] Renaming the folder failed:', err);
      setActionError(folderErrorMessage(err, 'The folder could not be renamed.'));
      setFolderNameDraft(selectedFolder.name);
    }
  };

  /** Deletes the open folder after confirming. Its decks move to Unfiled. */
  const handleDeleteFolder = async () => {
    if (!selectedFolder) return;
    try {
      setActionError(null);
      const deckCount = counts.get(selectedFolder.id) ?? 0;
      if (await confirmAndDeleteFolder(selectedFolder.id, selectedFolder.name, deckCount)) {
        onSelectFolder('all');
        await onLibraryChange();
      }
    } catch (err) {
      console.error('[library] Deleting the folder failed:', err);
      setActionError(`The folder "${selectedFolder.name}" could not be deleted.`);
    }
  };

  const ready = !loading && !error;
  // The first-visit empty state is for a shelf with nothing on it at all. Once
  // a folder exists, the folder bar is shown even with no decks.
  const firstVisit = ready && decks.length === 0 && folders.length === 0;
  const shelfVisible = ready && !firstVisit;

  const folderChip = (value: FolderFilter, label: string, count: number) => (
    <button
      key={value}
      type="button"
      className={`mode-chip folder-chip${filter === value ? ' active' : ''}`}
      aria-pressed={filter === value}
      onClick={() => onSelectFolder(value)}
    >
      {label}
      <span className="folder-chip-count">{count}</span>
    </button>
  );

  return (
    <div className="library">
      <div className="library-header">
        <div>
          <p className="eyebrow">Your card catalog</p>
          <h1>Decks on the shelf</h1>
        </div>
        <div className="library-header-actions">
          {shelfVisible && (
            <div className="sort-switch" role="radiogroup" aria-label="Sort folders and decks">
              {SORT_OPTIONS.map((option) => {
                const checked = sort === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    tabIndex={checked ? 0 : -1}
                    data-sort={option.value}
                    className={`mode-chip${checked ? ' active' : ''}`}
                    onClick={() => changeSort(option.value)}
                    onKeyDown={handleSortKey}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          )}
          <button className="primary-btn" onClick={() => onNewDeck(selectedFolder?.id)}>
            + New deck from a file
          </button>
        </div>
      </div>

      {loading && <p className="muted">Loading your decks…</p>}

      {error && <ErrorNotice title="Your decks could not be loaded" message={error} />}

      {actionError && <ErrorNotice message={actionError} />}

      {firstVisit && (
        <div className="empty-state">
          <div className="chalk-doodle" aria-hidden="true">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <rect x="4" y="7" width="14" height="10" rx="2" />
              <path d="M8 7V5.5A1.5 1.5 0 0 1 9.5 4h9A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H17" />
            </svg>
          </div>
          <h2>The shelf is empty</h2>
          <p>Upload a PDF or PowerPoint and Flashcard Forge will draft a deck for you to review.</p>
          <button className="primary-btn" onClick={() => onNewDeck()}>
            Upload your first document
          </button>
        </div>
      )}

      {shelfVisible && (
        <>
          {/* All first and Unfiled last whatever the sort; only real folders move. */}
          <nav className="folder-bar" aria-label="Folders">
            {folderChip('all', 'All decks', decks.length)}
            {sortedFolders.map((folder) =>
              folderChip(folder.id, folder.name, counts.get(folder.id) ?? 0)
            )}
            {folderChip(UNFILED, 'Unfiled', counts.get(UNFILED) ?? 0)}
            {creatingFolder ? (
              <form
                className="folder-chip-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  submitNewFolder();
                }}
                onBlur={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) cancelNewFolder();
                }}
              >
                <input
                  autoFocus
                  className="folder-chip-input"
                  aria-label="New folder name"
                  placeholder="Folder name"
                  value={newFolderDraft}
                  onChange={(e) => setNewFolderDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      cancelNewFolder();
                    }
                  }}
                />
                <button type="submit" className="icon-btn folder-chip-confirm" title="Create folder" aria-label="Create folder">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                </button>
                <button type="button" className="icon-btn" title="Cancel" aria-label="Cancel" onClick={cancelNewFolder}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              </form>
            ) : (
              <button type="button" className="mode-chip folder-chip new-folder" onClick={startNewFolder}>
                + New folder
              </button>
            )}
          </nav>

          {selectedFolder && (
            <div className="folder-toolbar">
              <input
                className="folder-title-input"
                aria-label="Folder name"
                value={folderNameDraft}
                onChange={(e) => setFolderNameDraft(e.target.value)}
                onBlur={commitFolderName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
              />
              <button className="ghost-btn small danger-text" onClick={handleDeleteFolder}>
                Delete folder
              </button>
            </div>
          )}

          {visibleDecks.length === 0 ? (
            <div className="empty-state compact">
              <h2>
                {selectedFolder
                  ? 'No decks in this folder yet'
                  : filter === UNFILED
                    ? 'No unfiled decks'
                    : 'No decks yet'}
              </h2>
              <button className="primary-btn" onClick={() => onNewDeck(selectedFolder?.id)}>
                {selectedFolder ? `Upload a document into ${selectedFolder.name}` : 'Upload a document'}
              </button>
            </div>
          ) : (
            <div className="deck-grid">
              {visibleDecks.map((deck) => {
                const deckFolder = folderOf(deck, folderIds);
                // Only in All: inside a folder the tag would repeat its name on every card.
                const folderName =
                  filter === 'all' && deckFolder !== UNFILED ? folderNames.get(deckFolder) : undefined;
                return (
                  <div key={deck.id} className="deck-card" onClick={() => onManage(deck.id)}>
                    <div className="deck-card-top">
                      <div className="deck-card-tags">
                        <span className={`source-tag source-${deck.sourceType}`}>{deck.sourceType}</span>
                        {folderName && (
                          <span className="folder-tag" title={folderName}>
                            {folderName}
                          </span>
                        )}
                      </div>
                      <button
                        className="icon-btn danger"
                        title="Delete deck"
                        onClick={(e) => handleDelete(e, deck.id, deck.name)}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <path d="M18 6 6 18M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                    <h3>{deck.name}</h3>
                    <p className="deck-meta">
                      {deck.cardCount} card{deck.cardCount === 1 ? '' : 's'} · from {deck.sourceFileName}
                    </p>
                    <div className="deck-card-actions">
                      <button
                        className="secondary-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          onStudy(deck.id);
                        }}
                      >
                        Study
                      </button>
                      <button
                        className="ghost-btn small"
                        onClick={(e) => {
                          e.stopPropagation();
                          onManage(deck.id);
                        }}
                      >
                        Manage cards
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
