/**
 * MAX TCP protocol opcodes — see max-protocol-full.md (05.08.2026) §1.5.
 * Named constants so payload-shaping code never has to spell out a bare hex literal.
 */
export const OPCODES = {
  PING: 0x0001,
  INIT: 0x0006,
  PROFILE: 0x0010,
  START_AUTH: 0x0011,
  CHECK_CODE: 0x0012,
  LOGIN: 0x0013,
  // Not in max-protocol-full.md — supplied by the user 2026-08-14 from a live capture.
  // Sent instead of LOGIN when CHECK_CODE's response carries a `passwordChallenge`
  // instead of a login token (some MAX accounts have a password set as a second
  // factor on top of SMS). `{trackId, password}` (plaintext) -> the same 663-char
  // login token CHECK_CODE would have returned directly; from there it's an ordinary
  // LOGIN. trackId survives a wrong password (retry freely, error `password2fa.wrong`)
  // but burns on success — a fresh SMS is needed for the next login attempt after that.
  CHECK_PASSWORD: 0x0073,
  CONTACT_INFO: 0x0020,
  // Contact search — supplied by the user 2026-08-16. Search by name/nick ({query, count})
  // and lookup by phone ({phone} — field is `phone`, not phoneNumber; `+` optional).
  CONTACT_SEARCH: 0x0025,
  CONTACT_INFO_BY_PHONE: 0x002e,
  // Global directory search by name — CONTACT_SEARCH (0x0025) only hits the account's
  // LOCAL address book (empty book => total:0 even for existing users). Supplied by the
  // user 2026-08-16.
  PUBLIC_SEARCH: 0x003c,
  CHAT_INFO: 0x0030,
  CHAT_HISTORY: 0x0031,
  // Not in max-protocol-full.md — supplied by the user 2026-08-10.
  CHAT_DELETE: 0x0034,
  CHATS_LIST: 0x0035,
  // Not in max-protocol-full.md — supplied by the user 2026-08-10. Renamed from their
  // "CHAT_UPDATE" to avoid colliding with the existing CHAT_UPDATE (0x0087) push, which
  // is a different, already-wired-up opcode (see its own comment below). This one updates
  // a group's title/description: `{chatId, title, description}`.
  CHAT_SET_INFO: 0x0037,
  // Not in max-protocol-full.md — supplied by the user 2026-08-10. `{chatId}`.
  CHAT_LEAVE: 0x003a,
  CHAT_MEMBERS: 0x003b,
  MSG_SEND: 0x0040,
  // Corrected 2026-08-09 (was 0x0041, an untested guess) — still unused: Telegram's
  // Bot API gives bots no way to detect a human typing, so there's nothing on the
  // Telegram side that could ever trigger sending this to MAX. Kept for reference.
  MSG_TYPING: 0x0065,
  // `{chatId, messageIds: [...], forMe: bool}` — supplied by the user 2026-08-10.
  MSG_DELETE: 0x0042,
  MSG_EDIT: 0x0043,
  // `{chatId, message: {cid, link: {type: 'FORWARD', messageId, chatId}, attaches: []}, notify}`
  // — supplied by the user 2026-08-10. `link.messageId` is a decimal STRING, not the usual int.
  FORWARD: 0x0046,
  MSG_GET: 0x0047,
  // Not in max-protocol-full.md — supplied by the user from their own reverse-engineering
  // (2026-08-07). {count} request; PHOTO/FILE return an upload slot {url, ...ids},
  // FILE_DOWNLOAD exchanges {chatId, messageId, fileId} for a signed {url}.
  PHOTO_UPLOAD: 0x0050,
  // User-confirmed 2026-08-13 from their own reverse-engineering (real MAX client
  // traffic) — a dedicated upload slot for stickers, distinct from FILE_UPLOAD/
  // VIDEO_UPLOAD (uploading a .tgs through FILE_UPLOAD lands as a plain file
  // attachment with an auto-generated preview, not a native rendered sticker).
  STICKER_UPLOAD: 0x0051,
  VIDEO_UPLOAD: 0x0052,
  VIDEO_PLAY: 0x0053,
  FILE_UPLOAD: 0x0057,
  FILE_DOWNLOAD: 0x0058,
  PUSH_MESSAGE: 0x0080,
  PUSH_TYPING: 0x0081,
  // Not in max-protocol-full.md — inferred live on 2026-08-06 from real traffic:
  // payload {chatId, userId, mark, setAsUnread}, looks like a read-marker update.
  PUSH_READ_MARK: 0x0082,
  PUSH_PRESENCE: 0x0084,
  // Not in max-protocol-full.md — a "chat updated" push carrying the full chat
  // object, `{chat: {...}}`. Initially mistaken (2026-08-07) for the reaction-push
  // mechanism because `lastReactedMessageId`/`lastReaction` on the chat object kept
  // showing up right after our own reaction tests — but the user later confirmed
  // MAX sends NO push at all for reactions (add or remove) through the normal
  // message channel; those fields are just persistent chat state that happens to
  // get echoed on unrelated resyncs. Real reaction notifications are NOTIF_MSG_*
  // below. Not currently used for anything (kept documented as a dead end so it
  // doesn't get "rediscovered" and misused the same way again).
  CHAT_UPDATE: 0x0087,
  EVENTS: 0x0088,
  // Not in max-protocol-full.md — supplied by the user 2026-08-09. Real-time incoming-call
  // push: `{caller, callId, chatId}`. We only relay the notification — actually placing or
  // joining a call needs WebRTC, out of scope for a Telegram Bot API bridge.
  NOTIF_CALL_START: 0x0089,
  // Not in max-protocol-full.md — supplied by the user 2026-08-10. Push sent when a
  // message is deleted (by anyone, either side) — payload shape unconfirmed until tested live.
  NOTIF_MSG_DELETE: 0x008e,
  // Not in max-protocol-full.md — supplied by the user 2026-08-07, who described
  // messageId as a decimal string for MSG_REACTION specifically (int for the other
  // two). A live "Expected number" validation error at the exact byte the string
  // started contradicted that — all three actually want messageId packed as the
  // same integer (BigInt) type. Pass it through unconverted everywhere.
  MSG_REACTION: 0x00b2,
  MSG_CANCEL_REACTION: 0x00b3,
  // Not in max-protocol-full.md — supplied by the user 2026-08-08. The real reaction
  // push opcodes; only fire when ANOTHER user reacts to a message *you* sent (not for
  // your own reactions on others' messages, and apparently not for removals either —
  // unverified either way, payload shape unknown until tested live).
  NOTIF_MSG_REACTIONS_CHANGED: 0x009b,
  NOTIF_MSG_YOU_REACTED: 0x009c,
  // Not in max-protocol-full.md — supplied by the user 2026-08-08, for polling current
  // reaction state on a message (used to detect removal, since MAX sends no live push
  // for it — see bridge/sync.ts). Response shape assumed to match MSG_REACTION's
  // `{reactionInfo: {...}}`, unverified until tested live.
  MSG_GET_REACTIONS: 0x00b4,
  // Not in max-protocol-full.md — supplied by the user 2026-08-09. Poll creation
  // itself has no dedicated opcode — it's a MSG_SEND with an `_type: 'POLL'` attach
  // (see bridge/sync.ts for the shape). These two are for voting on an existing poll.
  SEND_VOTE: 0x0130,
  VOTERS_LIST_BY_ANSWER: 0x0131,
} as const;

export type Opcode = (typeof OPCODES)[keyof typeof OPCODES];

const OPCODE_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(OPCODES).map(([name, code]) => [code, name]),
);

export function opcodeName(opcode: number): string {
  return OPCODE_NAMES[opcode] ?? 'UNKNOWN';
}

export function formatOpcode(opcode: number): string {
  const hex = '0x' + opcode.toString(16).padStart(4, '0').toUpperCase();
  return `${hex} [${opcodeName(opcode)}]`;
}

/** Frame `cmd` byte (direction marker in the header). */
export const DIR = {
  TX: 0x00,
  OK: 0x01,
  ERR: 0x03,
} as const;

export const PROTOCOL_VERSION = 0x0b;
