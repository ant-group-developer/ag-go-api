import type { ConfigService } from '@nestjs/config';
import { GOTENBERG_CONVERT_PATH, GotenbergClient, PdfConversionError } from './gotenberg.client';

function client(url: string | undefined) {
  const config = { get: (name: string) => (name === 'GOTENBERG_URL' ? url : undefined) };
  return new GotenbergClient(config as unknown as ConfigService);
}

describe('GotenbergClient', () => {
  const fetchMock = jest.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('is off without GOTENBERG_URL (DOCX only, Q4)', async () => {
    expect(client('').isConfigured()).toBe(false);
    await expect(client(undefined).convertDocx(Buffer.from('x'))).rejects.toBeInstanceOf(
      PdfConversionError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts the DOCX as multipart `files` and returns the PDF', async () => {
    fetchMock.mockResolvedValue(new Response(Buffer.from('%PDF-1.7'), { status: 200 }));
    const pdf = await client('http://gotenberg:3000/').convertDocx(Buffer.from('docx'));
    expect(pdf.toString()).toBe('%PDF-1.7');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://gotenberg:3000${GOTENBERG_CONVERT_PATH}`);
    expect(init.method).toBe('POST');
    const file = (init.body as FormData).get('files') as File;
    expect(file.name).toBe('document.docx');
  });

  it('retries a 5xx once, then reports a readable error', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(new Response(Buffer.from('%PDF'), { status: 200 }));
    await expect(client('http://g').convertDocx(Buffer.from('d'))).resolves.toEqual(
      Buffer.from('%PDF'),
    );
    fetchMock.mockResolvedValue(new Response('busy', { status: 502 }));
    await expect(client('http://g').convertDocx(Buffer.from('d'))).rejects.toThrow(
      'Gotenberg trả lỗi 502 khi đổi sang PDF.',
    );
  });

  it('does not retry a 4xx and maps network errors', async () => {
    fetchMock.mockResolvedValue(new Response('bad', { status: 400 }));
    await expect(client('http://g').convertDocx(Buffer.from('d'))).rejects.toThrow('400');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(client('http://g').convertDocx(Buffer.from('d'))).rejects.toThrow(
      'Không kết nối được dịch vụ đổi PDF (Gotenberg).',
    );
  });
});
