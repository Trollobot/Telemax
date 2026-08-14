import { addExtension, unpack, unpackMultiple } from 'msgpackr';

/**
 * Ext type code=1 wraps a nested msgpack-encoded buffer (max-protocol-full.md §1.4).
 * msgpackr's addExtension typings require `Class`/`pack` even for an unpack-only
 * extension, hence the cast — this extension is never used for packing.
 * Registered once at module load (ES modules only ever execute once).
 */
addExtension({
  type: 1,
  unpack: (buffer: Buffer) => unpack(buffer),
} as Parameters<typeof addExtension>[0]);

/**
 * Decodes a (decompressed) frame payload. Some MAX responses concatenate more
 * than one top-level msgpack value in a single payload, so this returns all of them.
 */
export function decodeFramePayload(buf: Buffer): unknown[] {
  if (buf.length === 0) return [];
  return unpackMultiple(buf) as unknown[];
}

export function pickObject(items: unknown[]): Record<string, unknown> | undefined {
  return items.find(
    (item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item),
  );
}
