/**
 * One file as a .zip — for a file MAX refuses to take as it is (an .html answered «415 Unsupported
 * Media Type», 2026-11-21, while a .zip went through). Deflated with node's own zlib, no dependency.
 * Only what a single small file needs: no ZIP64 (inputs are under Telegram's 20 MB bot download
 * limit), the name in UTF-8 (general-purpose flag bit 11) so Cyrillic names survive.
 */
import { crc32, deflateRawSync } from 'node:zlib';

/** DOS date/time fields of a ZIP entry, from local time. */
function dosDateTime(date: Date): { time: number; day: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    day: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Exported for tests. `date` is fixed in tests so the bytes are reproducible. */
export function zipSingleFile(name: string, data: Buffer, date = new Date()): Buffer {
  const nameBytes = Buffer.from(name, 'utf8');
  const deflated = deflateRawSync(data);
  // Stored when deflate does not help (an already-compressed file): method 0, the bytes as they are.
  const stored = deflated.length >= data.length;
  const body = stored ? data : deflated;
  const method = stored ? 0 : 8;
  const crc = crc32(data) >>> 0;
  const { time, day } = dosDateTime(date);
  const UTF8 = 0x0800;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(UTF8, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(day, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  local.writeUInt16LE(0, 28); // extra length

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(UTF8, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(day, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  // extra, comment, disk number, internal attrs, external attrs: 0
  central.writeUInt32LE(0, 42); // offset of the local header

  const centralOffset = local.length + nameBytes.length + body.length;
  const centralSize = central.length + nameBytes.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8); // entries on this disk
  end.writeUInt16LE(1, 10); // entries in total
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);

  return Buffer.concat([local, nameBytes, body, central, nameBytes, end]);
}
