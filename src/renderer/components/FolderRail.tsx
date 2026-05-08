// Left-rail folder picker: lists IMAP folders / Gmail labels for each
// connected account. Click a folder → store.setCurrentFolder → React
// Query in App.tsx re-runs sync.getEmails with the matching filter.
//
// Design notes:
//   - Always show "Inbox" as the first item per account, even when the
//     account block is collapsed. Selected by default (folder = null).
//   - Per-account folder lists are fetched lazily and cached in component
//     state so a quick collapse/expand cycle doesn't refire the network.
//   - Counts are deliberately NOT fetched here. Per-label totals would
//     mean N + 1 calls on first paint for accounts with many labels.
//   - System folders (Inbox/Sent/Drafts/Trash/etc.) bubble to the top so
//     the user-created labels live below the boundary.

import { useEffect, useState, useCallback } from "react";
import { useAppStore, type Account } from "../store";

interface FolderEntry {
  /** Path or label-id passed to sync.getEmails. */
  key: string;
  /** Display name in the rail. */
  label: string;
  /** Sort hint — system folders first. */
  isSystem: boolean;
  /** Optional swatch (Gmail user labels carry a colour). */
  color: string | null;
}

// Stable sort: system folders first (alphabetical), then user labels
// (alphabetical). Inbox is rendered separately at the top so we omit it
// from the sortable bucket.
function sortFolders(items: FolderEntry[]): FolderEntry[] {
  return [...items].sort((a, b) => {
    if (a.isSystem !== b.isSystem) return a.isSystem ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
}

function specialUseToLabel(specialUse: string | null, fallback: string): string {
  switch (specialUse) {
    case "\\Sent":
      return "Sent";
    case "\\Drafts":
      return "Drafts";
    case "\\Trash":
      return "Trash";
    case "\\Junk":
      return "Junk";
    case "\\Archive":
      return "Archive";
    case "\\All":
      return "All Mail";
    default:
      return fallback;
  }
}

function gmailSystemNameToLabel(id: string, fallback: string): string {
  switch (id) {
    case "INBOX":
      return "Inbox";
    case "SENT":
      return "Sent";
    case "DRAFT":
      return "Drafts";
    case "TRASH":
      return "Trash";
    case "SPAM":
      return "Spam";
    case "STARRED":
      return "Starred";
    case "IMPORTANT":
      return "Important";
    default:
      return fallback;
  }
}

async function fetchFoldersFor(account: Account): Promise<FolderEntry[]> {
  if (account.provider === "imap") {
    const result = await window.api.imap.listFolders(account.id);
    if (!result.success) throw new Error(result.error);
    return result.data.folders
      .filter((f) => f.specialUse !== "\\Inbox" && f.path !== "INBOX")
      .map((f) => ({
        key: f.path,
        label: specialUseToLabel(f.specialUse, f.name),
        isSystem: f.isSystem,
        color: null,
      }));
  }
  // Gmail (default). `window.api.gmail.listLabels` is typed via WindowApi
  // (see src/shared/window-api.ts) so the result flows back unwrapped.
  const result = await window.api.gmail.listLabels(account.id);
  if (!result.success) throw new Error(result.error);
  return result.data.labels
    .filter((l) => l.id !== "INBOX")
    .map((l) => ({
      key: l.id,
      label: l.type === "system" ? gmailSystemNameToLabel(l.id, l.name) : l.name,
      isSystem: l.type === "system",
      color: l.color,
    }));
}

interface AccountFolderBlockProps {
  account: Account;
  isCurrent: boolean;
}

function AccountFolderBlock({ account, isCurrent }: AccountFolderBlockProps) {
  const [expanded, setExpanded] = useState(isCurrent);
  const [folders, setFolders] = useState<FolderEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentFolder = useAppStore((s) => s.currentFolder);
  const setCurrentAccountId = useAppStore((s) => s.setCurrentAccountId);
  const setCurrentFolder = useAppStore((s) => s.setCurrentFolder);

  const ensureFolders = useCallback(async () => {
    if (folders !== null || loading) return;
    setLoading(true);
    setError(null);
    try {
      const list = await fetchFoldersFor(account);
      setFolders(sortFolders(list));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [account, folders, loading]);

  useEffect(() => {
    if (expanded) {
      void ensureFolders();
    }
  }, [expanded, ensureFolders]);

  const switchToInbox = () => {
    if (!isCurrent) setCurrentAccountId(account.id);
    setCurrentFolder(null);
  };

  const pickFolder = (key: string) => {
    if (!isCurrent) setCurrentAccountId(account.id);
    setCurrentFolder(key);
  };

  const inboxSelected = isCurrent && currentFolder === null;

  return (
    <div className="mb-2">
      {/* Account header row — disclosure + email */}
      <div className="flex items-center px-2 py-1 text-xs text-aos-text-soft uppercase tracking-wide">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="w-4 mr-1 inline-flex items-center justify-center text-aos-text-faint hover:text-aos-text-soft transition-colors"
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          <svg
            className={`w-3 h-3 transition-transform ${expanded ? "rotate-90" : ""}`}
            viewBox="0 0 12 12"
            fill="currentColor"
          >
            <path d="M4 2l4 4-4 4z" />
          </svg>
        </button>
        <span className="truncate flex-1" title={account.email}>
          {account.email}
        </span>
      </div>

      {/* Inbox: always present, even when collapsed. */}
      <button
        type="button"
        onClick={switchToInbox}
        className={`w-full text-left text-sm pl-7 pr-2 py-1 flex items-center gap-1.5 transition-colors ${
          inboxSelected
            ? "bg-aos-bg-sunk text-aos-text font-medium"
            : "text-aos-text-soft hover:bg-aos-bg-sunk hover:text-aos-text"
        }`}
      >
        <svg
          className="w-3.5 h-3.5 flex-shrink-0"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
          />
        </svg>
        <span className="truncate">Inbox</span>
      </button>

      {/* Sub-folders — only when expanded. */}
      {expanded && (
        <div>
          {loading && (
            <div className="pl-7 pr-2 py-1 text-xs text-aos-text-faint italic">Loading…</div>
          )}
          {error && (
            <div className="pl-7 pr-2 py-1 space-y-1">
              <p className="text-xs text-red-500" title={error}>
                {/* DNS / network failures surface as "getaddrinfo ENOTFOUND <host>"
                    — translate the canonical cases to friendly copy. Anything
                    else falls through with the raw message so we never hide a
                    real problem. */}
                {error.includes("ENOTFOUND") || error.includes("getaddrinfo")
                  ? "Couldn't reach the mail server. Check your connection."
                  : error.includes("ECONNREFUSED") || error.includes("ETIMEDOUT")
                    ? "Mail server didn't respond. Try again in a moment."
                    : error.includes("Invalid credentials") ||
                        error.includes("LOGIN") ||
                        error.includes("AUTHENTICATIONFAILED")
                      ? "Sign-in failed. Re-enter the IMAP password in Settings → Accounts."
                      : `Couldn't load folders: ${error}`}
              </p>
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setFolders(null);
                  // re-trigger the fetch by toggling expand off and on
                  setExpanded(false);
                  setTimeout(() => setExpanded(true), 0);
                }}
                className="text-xs text-aos-text-soft underline hover:text-aos-text"
              >
                Retry
              </button>
            </div>
          )}
          {folders?.map((f) => {
            const selected = isCurrent && currentFolder === f.key;
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => pickFolder(f.key)}
                className={`w-full text-left text-sm pl-7 pr-2 py-1 flex items-center gap-1.5 transition-colors ${
                  selected
                    ? "bg-aos-bg-sunk text-aos-text font-medium"
                    : "text-aos-text-soft hover:bg-aos-bg-sunk hover:text-aos-text"
                }`}
                title={f.label}
              >
                {f.color ? (
                  <span
                    className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
                    style={{ backgroundColor: f.color }}
                  />
                ) : (
                  <span className="inline-block w-2.5 h-2.5 flex-shrink-0" />
                )}
                <span className="truncate">{f.label}</span>
              </button>
            );
          })}
          {folders && folders.length === 0 && !loading && !error && (
            <div className="pl-7 pr-2 py-1 text-xs text-aos-text-faint italic">No folders</div>
          )}
        </div>
      )}
    </div>
  );
}

export function FolderRail() {
  const accounts = useAppStore((s) => s.accounts);
  const currentAccountId = useAppStore((s) => s.currentAccountId);

  if (accounts.length === 0) return null;

  // Renders folder list contents only — the surrounding <aside> shell
  // (width, border, scroll) is provided by the parent layout in App.tsx
  // so other rail siblings (e.g. AwaitingReplyRail) can share it.
  return (
    <div className="flex-1" data-testid="folder-rail">
      {accounts.map((acc) => (
        <AccountFolderBlock key={acc.id} account={acc} isCurrent={acc.id === currentAccountId} />
      ))}
    </div>
  );
}
