import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CardFsFileType,
  CardSdk,
  getKeyFromBlob,
  type CardEventHandler,
  type CardInitData,
  type CardInitErrorPayload,
  type CardKeyBlobV1,
  type CardUser,
} from 'dome-embedded-app-sdk';

import './App.css';

type JournalEntries = Record<string, string>;

const JOURNAL_FILE_PATH = 'journal/entries.json';

function getLocalDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDateLabel(dateKey: string): string {
  const parsed = new Date(`${dateKey}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return dateKey;
  }

  return parsed.toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function isValidEntries(data: unknown): data is JournalEntries {
  if (!data || typeof data !== 'object') {
    return false;
  }

  return Object.values(data).every((value) => typeof value === 'string');
}

function normalizeEntries(data: unknown): JournalEntries | null {
  if (isValidEntries(data)) {
    return data;
  }

  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data) as unknown;
      if (isValidEntries(parsed)) {
        return parsed;
      }
    } catch {
      return null;
    }
  }

  return null;
}

function App() {
  const [user, setUser] = useState<CardUser | null>(null);
  const [sdk, setSdk] = useState<CardSdk | null>(null);
  const [initError, setInitError] = useState<CardInitErrorPayload | null>(null);

  const [entries, setEntries] = useState<JournalEntries>({});
  const [todayText, setTodayText] = useState('');
  const [isLoadingEntries, setIsLoadingEntries] = useState(true);
  const [hasFinishedFirstLoad, setHasFinishedFirstLoad] = useState(false);
  const [hasReceivedOnInit, setHasReceivedOnInit] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [canWrite, setCanWrite] = useState(true);

  const hasInitialized = useRef(false);
  const todayKey = getLocalDateKey(new Date());

  useEffect(() => {
    if (hasInitialized.current) {
      return;
    }
    hasInitialized.current = true;

    const decBlob = import.meta.env.VITE_CARD_DEC_BLOB;
    if (!decBlob) {
      setInitError({
        message: 'Missing VITE_CARD_DEC_BLOB env variable',
        error_code: 'MISSING_CARD_DEC_BLOB',
      });
      return;
    }

    let cardDecryptionBlob: CardKeyBlobV1;
    try {
      cardDecryptionBlob = JSON.parse(decBlob) as CardKeyBlobV1;
    } catch {
      setInitError({
        message: 'Invalid VITE_CARD_DEC_BLOB JSON',
        error_code: 'INVALID_CARD_DEC_BLOB',
      });
      return;
    }

    const eventHandler: CardEventHandler = {
      onInit: (data: CardInitData) => {
        const { user: initUser, ui } = data;

        if (initUser) {
          setUser(initUser);
        }

        if (ui?.theme) {
          document.documentElement.setAttribute('data-theme', ui.theme);
        }

        setHasReceivedOnInit(true);
      },
      onInitError: (data: CardInitErrorPayload) => {
        setInitError(data);
      },
      onError: (data: { message: string; error_code: string | number }) => {
        console.error('Some Error', `${data.message} (${data.error_code})`);
      },
    };

    CardSdk.init(getKeyFromBlob(cardDecryptionBlob), eventHandler)
      .then((initializedSdk) => {
        setSdk(initializedSdk);
        setCanWrite(initializedSdk.canWrite());
      })
      .catch((err) => {
        console.error('Init failed', err);
      });
  }, []);

  useEffect(() => {
    if (!sdk || !hasReceivedOnInit) {
      return;
    }

    setIsLoadingEntries(true);
    setSaveError(null);

    sdk.cardFS.read(JOURNAL_FILE_PATH, {
      next: (payload) => {
        const parsedEntries = normalizeEntries(payload?.data);

        // cardFS.read can emit intermediate payloads with no data yet.
        if (parsedEntries) {
          setEntries(parsedEntries);
          setTodayText(parsedEntries[todayKey] ?? '');
        } else if (payload?.is_complete) {
          setEntries({});
          setTodayText('');
        }

        if (payload?.is_complete || parsedEntries) {
          setIsLoadingEntries(false);
          setHasFinishedFirstLoad(true);
        }
      },
      error: () => {
        // Missing file or read error should not block journaling.
        setEntries({});
        setTodayText('');
        setIsLoadingEntries(false);
        setHasFinishedFirstLoad(true);
      },
    });
  }, [sdk, hasReceivedOnInit, todayKey]);

  const orderedEntries = useMemo(() => {
    return Object.entries(entries)
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([date, text]) => ({ date, text }));
  }, [entries]);

  const saveTodayEntry = async () => {
    if (!sdk || !hasReceivedOnInit || !canWrite) {
      return;
    }

    setIsSaving(true);
    setSaveError(null);

    const updatedEntries = { ...entries };
    if (todayText.trim()) {
      updatedEntries[todayKey] = todayText.trim();
    } else {
      delete updatedEntries[todayKey];
    }

    try {
      await sdk.cardFS.write(JOURNAL_FILE_PATH, updatedEntries, CardFsFileType.JSON);
      setEntries(updatedEntries);
    } catch (err) {
      console.error('Failed to save journal entry', err);
      setSaveError('Could not save your journal entry. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  if (initError) {
    return (
      <div className="main">
        <h3>Initialization Failed</h3>
        <p>
          {initError.message} ({initError.error_code})
        </p>
      </div>
    );
  }

  if (!hasFinishedFirstLoad) {
    return (
      <main className="main loading-main">
        <div className="loading-wrap" role="status" aria-live="polite" aria-label="Loading journal entries">
          <div className="spinner" />
          <p>Loading your journal...</p>
        </div>
      </main>
    );
  }

  return (
    <main className="main">
      <section className="journal-card">
        <header className="journal-header">
          <h1>Daily Journal</h1>
          <p>{user ? `Hi ${user.getFullName?.() || 'there'}` : 'Loading profile...'}</p>
        </header>

        <section className="today-entry">
          <h2>Today ({formatDateLabel(todayKey)})</h2>
          <textarea
            value={todayText}
            onChange={(event) => setTodayText(event.target.value)}
            placeholder="Write your thoughts for today..."
            disabled={!canWrite || isLoadingEntries}
          />
          <div className="actions-row">
            <button type="button" onClick={saveTodayEntry} disabled={!canWrite || isSaving || isLoadingEntries}>
              {isSaving ? 'Saving...' : 'Save Today'}
            </button>
            {!canWrite && <span className="status-text">You only have read access in this card.</span>}
            {saveError && <span className="status-text error">{saveError}</span>}
          </div>
        </section>

        <section className="history">
          <h2>Previous Entries</h2>
          {isLoadingEntries ? (
            <p className="empty-state">Loading entries...</p>
          ) : orderedEntries.length === 0 ? (
            <p className="empty-state">No journal entries yet.</p>
          ) : (
            <ul>
              {orderedEntries.map((entry) => (
                <li key={entry.date}>
                  <h3>{formatDateLabel(entry.date)}</h3>
                  <p>{entry.text}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </section>
    </main>
  );
}

export default App;
