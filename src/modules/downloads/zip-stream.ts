import { Readable } from 'node:stream';
import { crc32 } from 'node:zlib';

export type ZipStreamEntry = { name: string; body: AsyncIterable<Buffer | Uint8Array> };

const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;
// General purpose flag bit 3: CRC and sizes follow the data in a data descriptor, so an
// entry can be written while it streams instead of being buffered to compute them first.
const FLAG_DATA_DESCRIPTOR = 0x0008;
const VERSION_DEFAULT = 20;
const VERSION_ZIP64 = 45;

type CentralRecord = { name: Buffer; crc: number; size: number; offset: number };
type DosDateTime = { time: number; date: number };

/**
 * Streams a STORED (uncompressed) ZIP archive, reading one entry body at a time, so memory
 * stays flat regardless of archive size. Entries are pulled lazily: the next entry is only
 * requested once the previous body has been fully written.
 *
 * Like Go's archive/zip, sizes are only known after an entry is written, so ZIP64 fields are
 * added per entry in the data descriptor and central directory once a size or offset passes
 * 4 GiB; archives below that limit stay plain ZIP for the widest reader support.
 */
export function createZipStream(entries: AsyncIterable<ZipStreamEntry>): Readable {
  return Readable.from(zipChunks(entries), { objectMode: false });
}

async function* zipChunks(entries: AsyncIterable<ZipStreamEntry>): AsyncGenerator<Buffer> {
  const records: CentralRecord[] = [];
  const modified = dosDateTime(new Date());
  let offset = 0;
  for await (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/[^\w.\-/]/g, '_'), 'utf8');
    const header = localHeader(name, modified);
    yield header;

    let crc = 0;
    let size = 0;
    for await (const chunk of entry.body) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (data.length === 0) {
        continue;
      }
      crc = crc32(data, crc);
      size += data.length;
      yield data;
    }

    const descriptor = dataDescriptor(crc, size);
    yield descriptor;
    records.push({ name, crc, size, offset });
    offset += header.length + size + descriptor.length;
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const record of records) {
    const header = centralHeader(record, modified);
    centralSize += header.length;
    yield header;
  }
  yield* endOfCentralDirectory(records.length, centralSize, centralOffset);
}

/** Every entry is stamped with the archive's creation time (MS-DOS format, UTC). */
function dosDateTime(value: Date): DosDateTime {
  return {
    time:
      (value.getUTCHours() << 11) |
      (value.getUTCMinutes() << 5) |
      Math.floor(value.getUTCSeconds() / 2),
    date:
      ((value.getUTCFullYear() - 1980) << 9) |
      ((value.getUTCMonth() + 1) << 5) |
      value.getUTCDate(),
  };
}

function localHeader(name: Buffer, modified: DosDateTime): Buffer {
  const header = Buffer.alloc(30 + name.length);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(VERSION_DEFAULT, 4);
  header.writeUInt16LE(FLAG_DATA_DESCRIPTOR, 6);
  // Method 0 (stored); CRC and sizes stay 0 and are given by the data descriptor.
  header.writeUInt16LE(modified.time, 10);
  header.writeUInt16LE(modified.date, 12);
  header.writeUInt16LE(name.length, 26);
  name.copy(header, 30);
  return header;
}

function dataDescriptor(crc: number, size: number): Buffer {
  if (size >= UINT32_MAX) {
    const descriptor = Buffer.alloc(24);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeBigUInt64LE(BigInt(size), 8);
    descriptor.writeBigUInt64LE(BigInt(size), 16);
    return descriptor;
  }
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(crc, 4);
  descriptor.writeUInt32LE(size, 8);
  descriptor.writeUInt32LE(size, 12);
  return descriptor;
}

function centralHeader({ name, crc, size, offset }: CentralRecord, modified: DosDateTime): Buffer {
  // The ZIP64 extra field lists only the values whose 32-bit slot holds the 0xFFFFFFFF
  // sentinel, in the order: uncompressed size, compressed size, local header offset.
  const zip64Values: number[] = [];
  if (size >= UINT32_MAX) {
    zip64Values.push(size, size);
  }
  if (offset >= UINT32_MAX) {
    zip64Values.push(offset);
  }
  const extra = Buffer.alloc(zip64Values.length > 0 ? 4 + zip64Values.length * 8 : 0);
  if (zip64Values.length > 0) {
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(zip64Values.length * 8, 2);
    zip64Values.forEach((value, index) => extra.writeBigUInt64LE(BigInt(value), 4 + index * 8));
  }
  const version = zip64Values.length > 0 ? VERSION_ZIP64 : VERSION_DEFAULT;

  const header = Buffer.alloc(46 + name.length + extra.length);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(version, 4);
  header.writeUInt16LE(version, 6);
  header.writeUInt16LE(FLAG_DATA_DESCRIPTOR, 8);
  header.writeUInt16LE(modified.time, 12);
  header.writeUInt16LE(modified.date, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(Math.min(size, UINT32_MAX), 20);
  header.writeUInt32LE(Math.min(size, UINT32_MAX), 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt16LE(extra.length, 30);
  header.writeUInt32LE(Math.min(offset, UINT32_MAX), 42);
  name.copy(header, 46);
  extra.copy(header, 46 + name.length);
  return header;
}

function* endOfCentralDirectory(
  count: number,
  centralSize: number,
  centralOffset: number,
): Generator<Buffer> {
  if (count >= UINT16_MAX || centralSize >= UINT32_MAX || centralOffset >= UINT32_MAX) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(VERSION_ZIP64, 12);
    record.writeUInt16LE(VERSION_ZIP64, 14);
    record.writeBigUInt64LE(BigInt(count), 24);
    record.writeBigUInt64LE(BigInt(count), 32);
    record.writeBigUInt64LE(BigInt(centralSize), 40);
    record.writeBigUInt64LE(BigInt(centralOffset), 48);
    yield record;

    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(centralOffset + centralSize), 8);
    locator.writeUInt32LE(1, 16);
    yield locator;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Math.min(count, UINT16_MAX), 8);
  end.writeUInt16LE(Math.min(count, UINT16_MAX), 10);
  end.writeUInt32LE(Math.min(centralSize, UINT32_MAX), 12);
  end.writeUInt32LE(Math.min(centralOffset, UINT32_MAX), 16);
  yield end;
}
