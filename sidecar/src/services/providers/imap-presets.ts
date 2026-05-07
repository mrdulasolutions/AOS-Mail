// Common IMAP/SMTP server presets so the user picks "iCloud" / "Yahoo"
// from a list instead of memorizing host names. Custom IMAP picks fall
// through to the manual host/port form.

export interface ImapPreset {
  id: string;
  label: string;
  /** Hint we surface in the picker. */
  hint: string;
  /** Email-address suffix that auto-suggests this preset. */
  domains?: string[];
  imap: { host: string; port: number; tls: true };
  smtp: { host: string; port: number; tls: true };
  /**
   * If true, the provider requires an app-specific password (regular
   * password is rejected). Surfaces a helpful note in the UI.
   */
  appPasswordRequired?: boolean;
  /** Help link the UI surfaces near the password field. */
  appPasswordHelp?: string;
}

export const IMAP_PRESETS: ImapPreset[] = [
  {
    id: "icloud",
    label: "iCloud",
    hint: "@icloud.com / @me.com / @mac.com",
    domains: ["icloud.com", "me.com", "mac.com"],
    imap: { host: "imap.mail.me.com", port: 993, tls: true },
    smtp: { host: "smtp.mail.me.com", port: 587, tls: true },
    appPasswordRequired: true,
    appPasswordHelp: "https://support.apple.com/en-us/HT204397",
  },
  {
    id: "fastmail",
    label: "Fastmail",
    hint: "@fastmail.com / @fastmail.fm / custom domains",
    domains: ["fastmail.com", "fastmail.fm"],
    imap: { host: "imap.fastmail.com", port: 993, tls: true },
    smtp: { host: "smtp.fastmail.com", port: 465, tls: true },
    appPasswordRequired: true,
    appPasswordHelp: "https://www.fastmail.help/hc/en-us/articles/360058752854",
  },
  {
    id: "yahoo",
    label: "Yahoo Mail",
    hint: "@yahoo.com / @ymail.com",
    domains: ["yahoo.com", "ymail.com", "rocketmail.com"],
    imap: { host: "imap.mail.yahoo.com", port: 993, tls: true },
    smtp: { host: "smtp.mail.yahoo.com", port: 465, tls: true },
    appPasswordRequired: true,
    appPasswordHelp: "https://help.yahoo.com/kb/SLN15241.html",
  },
  {
    id: "outlook",
    label: "Outlook / Hotmail (IMAP)",
    hint: "@outlook.com / @hotmail.com / @live.com",
    domains: ["outlook.com", "hotmail.com", "live.com", "msn.com"],
    imap: { host: "outlook.office365.com", port: 993, tls: true },
    smtp: { host: "smtp.office365.com", port: 587, tls: true },
  },
  {
    id: "aol",
    label: "AOL Mail",
    hint: "@aol.com",
    domains: ["aol.com"],
    imap: { host: "imap.aol.com", port: 993, tls: true },
    smtp: { host: "smtp.aol.com", port: 465, tls: true },
    appPasswordRequired: true,
    appPasswordHelp: "https://help.aol.com/articles/Create-and-manage-app-password",
  },
  {
    id: "gmail-imap",
    label: "Gmail (IMAP w/ app password)",
    hint: "@gmail.com — only if you'd rather use app password than OAuth",
    domains: [],
    imap: { host: "imap.gmail.com", port: 993, tls: true },
    smtp: { host: "smtp.gmail.com", port: 465, tls: true },
    appPasswordRequired: true,
    appPasswordHelp:
      "https://support.google.com/accounts/answer/185833 — note: OAuth via the Gmail tab is the better path",
  },
];

export function presetForEmail(email: string): ImapPreset | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const domain = email.slice(at + 1).toLowerCase();
  return IMAP_PRESETS.find((p) => p.domains?.includes(domain)) ?? null;
}
