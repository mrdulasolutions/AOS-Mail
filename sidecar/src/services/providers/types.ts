// Mail-provider abstraction — the shared shape AOS Mail's sync layer
// programs against, regardless of whether the underlying transport is
// Gmail's REST API, IMAP/SMTP, or (future) Microsoft Graph.
//
// V1 surface is intentionally small: list folders, list messages in a
// folder, get a single message, send a message, mark/move/trash. Real-time
// updates (push, IDLE) are layered on top via provider-specific events.

export type ProviderId = "gmail" | "imap";

export interface ProviderAccount {
  /** Stable identifier for this account; for AOS Mail we use the email. */
  accountId: string;
  /** Primary email address. */
  email: string;
  /** Display name from the provider's profile API (may be null). */
  displayName: string | null;
  /** Which provider this account uses. */
  provider: ProviderId;
}

export interface ProviderFolder {
  /** Provider-native folder identifier (Gmail: label id; IMAP: full path). */
  id: string;
  /** Display name (e.g. "INBOX", "Sent", "Custom/Subfolder"). */
  name: string;
  /** Path-style hierarchy if the provider supports nesting. */
  path: string[];
  /** True for the user's primary inbox folder. */
  isInbox: boolean;
  /** True for sent / draft / trash / spam / archive special folders. */
  specialUse?: "sent" | "drafts" | "trash" | "spam" | "archive" | "important";
  /** Approximate unread count (provider may not return real-time data). */
  unreadCount?: number;
}

export interface ProviderMessageHeader {
  id: string;
  threadId?: string;
  from: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  date: string;
  snippet: string;
  isUnread: boolean;
  isStarred?: boolean;
  labels?: string[];
}

export interface ProviderMessageFull extends ProviderMessageHeader {
  bodyHtml?: string;
  bodyText?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: Array<{
    id: string;
    filename: string;
    mimeType: string;
    size: number;
  }>;
}

/**
 * The shape implemented by each provider in `sidecar/src/services/providers/`.
 * Methods return primitives (not framework types) so the calling code
 * stays provider-agnostic.
 */
export interface MailProvider {
  readonly id: ProviderId;
  readonly account: ProviderAccount;

  /** Quick health check. Returns true if the connection / token is alive. */
  ping(): Promise<boolean>;

  /** List folders / labels available on this account. */
  listFolders(): Promise<ProviderFolder[]>;

  /**
   * List recent message headers in a folder. `cursor` is provider-specific
   * (Gmail: history id; IMAP: last UID). The returned `nextCursor` is the
   * point to resume from; `null` when there's nothing newer.
   */
  listMessages(opts: {
    folderId: string;
    cursor?: string | null;
    limit?: number;
  }): Promise<{ messages: ProviderMessageHeader[]; nextCursor: string | null }>;

  /** Fetch one full message by id (with body + attachments). */
  getMessage(id: string): Promise<ProviderMessageFull>;

  /** Mark unread/read. */
  markRead(id: string, read: boolean): Promise<void>;

  /** Move to trash (most providers handle a permanent-delete op separately). */
  trash(id: string): Promise<void>;

  /** Archive (Gmail: remove INBOX label; IMAP: move to Archive folder). */
  archive(id: string): Promise<void>;

  /** Send a fully-built RFC 822 message. Returns the provider message id. */
  sendRfc822(rfc822: Uint8Array): Promise<string>;

  /**
   * Disconnect / cleanup any persistent connections (IMAP is the main one;
   * Gmail's REST client doesn't keep state).
   */
  close(): Promise<void>;
}
