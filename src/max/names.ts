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

/** Falls back to `MAX ID <n>` when no profile was fetched for the other participant. */
export function resolveChatName(chat: unknown, myAccountId: number | null, contactProfiles: Map<number, ContactProfile>): string {
  const c = chat as RawChat;
  if (c.id === 0) return 'Избранное';
  if (c.options?.SERVICE_CHAT) return 'MAX (системный)';

  // A 1:1 dialog: type 'DIALOG', or a two-participant chat (dialogs created via
  // createDialog come back as type 'CHAT' with an empty title — without this they'd
  // render as the "CHAT <id>" fallback instead of the other person's name).
  const participantIds = c.participants ? Object.keys(c.participants).map(Number) : [];
  const looksLikeDialog =
    c.type === 'DIALOG' || (!c.title && participantIds.length === 2 && myAccountId != null && participantIds.includes(myAccountId));
  if (looksLikeDialog) {
    const otherId = participantIds.find((id) => id !== myAccountId);
    if (otherId != null) return resolveContactDisplayName(otherId, contactProfiles.get(otherId));
  }

  if (c.title) return c.title;
  return c.type ? `${c.type} ${String(c.id)}` : `Chat ${String(c.id)}`;
}
