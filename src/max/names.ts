/**
 * Resolves a human-readable label for a chat. DIALOG chats resolve the other
 * participant's name via CONTACT_INFO profiles (fetched separately — LOGIN's
 * own contacts[] only carries a single `name` per type, not firstName/lastName/
 * phone). CHAT/CHANNEL chats use their own `title`.
 */

interface RawName {
  name?: string;
  firstName?: string;
  lastName?: string;
  type?: string;
}

export interface ContactProfile {
  id?: unknown;
  names?: RawName[];
  phone?: unknown;
}

interface RawChat {
  id?: unknown;
  type?: string;
  title?: string;
  participants?: Record<string, unknown>;
  options?: { SERVICE_CHAT?: boolean };
}

function fullName(names: RawName[] | undefined, type: string): string | undefined {
  const entry = names?.find((n) => n.type === type);
  const combined = [entry?.firstName, entry?.lastName].filter(Boolean).join(' ').trim();
  return combined || undefined;
}

function label(names: RawName[] | undefined, type: string): string | undefined {
  const name = names?.find((n) => n.type === type)?.name;
  return name || undefined;
}

function formatPhone(phone: unknown): string | undefined {
  if (phone == null) return undefined;
  const digits = String(phone);
  return digits ? `+${digits}` : undefined;
}

export function extractMyAccountId(loginPayload: unknown): number | null {
  if (loginPayload && typeof loginPayload === 'object') {
    const id = (loginPayload as { profile?: { contact?: { id?: unknown } } }).profile?.contact?.id;
    if (typeof id === 'number') return id;
  }
  return null;
}

/**
 * ФИО (the contact's own profile first+last name) → ник (a custom label, ours
 * or theirs) → phone → numeric id, in that order — matches how a person would
 * actually want a stranger identified when no saved contact name exists.
 */
export function resolveContactDisplayName(id: number, profile: ContactProfile | undefined): string {
  if (!profile) return `MAX ID ${id}`;
  return (
    fullName(profile.names, 'ONEME') ??
    label(profile.names, 'CUSTOM') ??
    label(profile.names, 'ONEME') ??
    formatPhone(profile.phone) ??
    `MAX ID ${id}`
  );
}

/**
 * A 1:1 dialog: type 'DIALOG', or a two-participant chat (dialogs created via
 * createDialog come back as type 'CHAT' with an empty title — without this they'd
 * render as the "CHAT <id>" fallback instead of the other person's name).
 */
function looksLikeDialog(c: RawChat, participantIds: number[], myAccountId: number | null): boolean {
  return c.type === 'DIALOG' || (!c.title && participantIds.length === 2 && myAccountId != null && participantIds.includes(myAccountId));
}

/**
 * The other side of every 1:1 dialog in `chats` — the profiles resolveChatName needs to name their
 * topics. Group participants are left out: a few large groups used to swell the one CONTACT_INFO
 * request to thousands of ids (group rosters fetch their own, buildRoster). Deduplicated.
 */
export function dialogParticipantIds(chats: readonly unknown[], myAccountId: number | null): number[] {
  const ids = new Set<number>();
  for (const chat of chats) {
    const c = chat as RawChat | null;
    if (!c?.participants) continue;
    const participantIds = Object.keys(c.participants).map(Number);
    if (!looksLikeDialog(c, participantIds, myAccountId)) continue;
    for (const id of participantIds) if (!Number.isNaN(id) && id !== myAccountId) ids.add(id);
  }
  return [...ids];
}

/** Falls back to `MAX ID <n>` when no profile was fetched for the other participant. */
export function resolveChatName(chat: unknown, myAccountId: number | null, contactProfiles: Map<number, ContactProfile>): string {
  const c = chat as RawChat;
  if (c.id === 0) return 'Избранное';
  if (c.options?.SERVICE_CHAT) return 'MAX (системный)';

  const participantIds = c.participants ? Object.keys(c.participants).map(Number) : [];
  if (looksLikeDialog(c, participantIds, myAccountId)) {
    const otherId = participantIds.find((id) => id !== myAccountId);
    if (otherId != null) return resolveContactDisplayName(otherId, contactProfiles.get(otherId));
  }

  if (c.title) return c.title;
  return c.type ? `${c.type} ${String(c.id)}` : `Chat ${String(c.id)}`;
}

/**
 * A generic stand-in title this module produces when no real name is known — `CHAT <id>`,
 * `DIALOG <id>`, `CHANNEL <id>`, `GROUP <id>`, `Chat <id>` (resolveChatName), `MAX ID <id>`
 * (resolveContactDisplayName) or the `MAX chat <id>` a topic gets when created without a title.
 * A topic must never be renamed TO one of these, and a topic still carrying one is due for a
 * rename once a real name turns up. Anchored on the numeric id and case-sensitive, so a real
 * title such as «Chat друзей» or «Dialog club» is not mistaken for a fallback (review
 * 2026-09-26, C5/S11 — three diverging regexes used to disagree about that).
 */
export function isFallbackTitle(title: string | undefined | null): boolean {
  if (!title) return false;
  return /^(?:(?:CHAT|DIALOG|CHANNEL|GROUP|Chat) -?\d+|MAX (?:chat|ID) -?\d+)$/.test(title.trim());
}
