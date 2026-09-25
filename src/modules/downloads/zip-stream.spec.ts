import { Readable } from 'node:stream';
import { crc32 } from 'node:zlib';
import { createZipStream, type ZipStreamEntry } from './zip-stream';

async function buildZip(entries: ZipStreamEntry[]): Promise<Buffer> {
  async function* source() {
    yield* entries;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of createZipStream(source())) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

type ParsedEntry = { name: string; flags: number; crc: number; data: Buffer };

// Reads the archive the way unzip tools do: from the end of central directory record.
function readZip(zip: Buffer): ParsedEntry[] {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  let cursor = zip.readUInt32LE(end + 16);
  expect(cursor + zip.readUInt32LE(end + 12)).toBe(end);

  const entries: ParsedEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    expect(zip.readUInt32LE(cursor)).toBe(0x02014b50);
    const flags = zip.readUInt16LE(cursor + 8);
    const crc = zip.readUInt32LE(cursor + 16);
    const size = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const offset = zip.readUInt32LE(cursor + 42);
    const name = zip.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    expect(zip.readUInt32LE(offset)).toBe(0x04034b50);
    const dataStart = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    const data = zip.subarray(dataStart, dataStart + size);
    const descriptor = dataStart + size;
    expect(zip.readUInt32LE(descriptor)).toBe(0x08074b50);
    expect(zip.readUInt32LE(descriptor + 4)).toBe(crc);
    expect(zip.readUInt32LE(descriptor + 8)).toBe(size);
    expect(zip.readUInt32LE(descriptor + 12)).toBe(size);

    entries.push({ name, flags, crc, data });
    cursor += 46 + nameLength + extraLength;
  }
  return entries;
}

describe('createZipStream', () => {
  it('writes a stored archive whose entries match their streamed bodies', async () => {
    const photo = Buffer.alloc(200_000, 7);
    const zip = await buildZip([
      { name: 'a-photo.jpg', body: Readable.from([photo.subarray(0, 1000), photo.subarray(1000)]) },
      { name: 'b-empty.txt', body: Readable.from([]) },
      { name: 'c-note.txt', body: Readable.from([Buffer.from('hello'), new Uint8Array([33])]) },
    ]);

    const entries = readZip(zip);
    expect(entries.map((entry) => entry.name)).toEqual([
      'a-photo.jpg',
      'b-empty.txt',
      'c-note.txt',
    ]);
    expect(entries[0].data.equals(photo)).toBe(true);
    expect(entries[1].data.length).toBe(0);
    expect(entries[2].data.toString()).toBe('hello!');
    for (const entry of entries) {
      expect(entry.crc).toBe(crc32(entry.data));
      expect(entry.flags & 0x0008).toBe(0x0008);
    }
  });

  it('stamps entries with the archive creation time', async () => {
    jest.useFakeTimers({ now: new Date('2026-09-26T10:20:30Z') });
    try {
      const zip = await buildZip([{ name: 'a.txt', body: Readable.from([Buffer.from('x')]) }]);
      const central = zip.readUInt32LE(zip.length - 22 + 16);
      for (const at of [10, central + 12]) {
        expect(zip.readUInt16LE(at)).toBe((10 << 11) | (20 << 5) | 15);
        expect(zip.readUInt16LE(at + 2)).toBe(((2026 - 1980) << 9) | (9 << 5) | 26);
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it('writes a valid empty archive', async () => {
    const zip = await buildZip([]);
    expect(zip.length).toBe(22);
    expect(readZip(zip)).toEqual([]);
  });

  it('replaces characters outside the safe filename set', async () => {
    const zip = await buildZip([
      { name: 'ảnh đẹp 1.jpg', body: Readable.from([Buffer.from('x')]) },
    ]);
    expect(readZip(zip)[0].name).toBe('_nh___p_1.jpg');
  });

  it('fails the stream when an entry body errors', async () => {
    const body = new Readable({
      read() {
        this.destroy(new Error('R2 read failed'));
      },
    });
    await expect(buildZip([{ name: 'broken.jpg', body }])).rejects.toThrow('R2 read failed');
  });
});
