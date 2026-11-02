import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const GOTENBERG_CONVERT_PATH = '/forms/libreoffice/convert';

/** PDF conversion failed; the message can be shown to users (no document content in it). */
export class PdfConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfConversionError';
  }
}

/**
 * DOCX → PDF through Gotenberg (`POST /forms/libreoffice/convert`, spec 13), like AG Music's
 * GotenbergClient / DocxToPdfConverter: a 5xx (LibreOffice restarting) is retried once. Without
 * `GOTENBERG_URL` documents stay DOCX only (Q4).
 */
@Injectable()
export class GotenbergClient {
  private readonly logger = new Logger(GotenbergClient.name);

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.baseUrl());
  }

  async convertDocx(docx: Buffer): Promise<Buffer> {
    const base = this.baseUrl();
    if (!base) {
      throw new PdfConversionError('Chưa cấu hình dịch vụ đổi PDF (GOTENBERG_URL).');
    }
    try {
      return await this.post(base, docx);
    } catch (error) {
      if (error instanceof GotenbergHttpError && error.status >= 500) {
        this.logger.warn(`Gotenberg answered ${error.status}, retrying once`);
        try {
          return await this.post(base, docx);
        } catch (again) {
          throw this.failure(again);
        }
      }
      throw this.failure(error);
    }
  }

  private async post(base: string, docx: Buffer): Promise<Buffer> {
    const form = new FormData();
    // Gotenberg picks the converter from the file extension.
    form.append(
      'files',
      new Blob([new Uint8Array(docx)], {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
      'document.docx',
    );
    const response = await fetch(`${base}${GOTENBERG_CONVERT_PATH}`, {
      method: 'POST',
      body: form,
      redirect: 'error',
      signal: AbortSignal.timeout(this.config.get<number>('GOTENBERG_TIMEOUT_MS') ?? 60_000),
    });
    if (!response.ok) {
      throw new GotenbergHttpError(response.status);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  private failure(error: unknown): PdfConversionError {
    if (error instanceof PdfConversionError) {
      return error;
    }
    if (error instanceof GotenbergHttpError) {
      return new PdfConversionError(`Gotenberg trả lỗi ${error.status} khi đổi sang PDF.`);
    }
    return new PdfConversionError('Không kết nối được dịch vụ đổi PDF (Gotenberg).');
  }

  private baseUrl(): string | null {
    const url = this.config.get<string>('GOTENBERG_URL')?.trim();
    return url ? url.replace(/\/+$/, '') : null;
  }
}

class GotenbergHttpError extends Error {
  constructor(readonly status: number) {
    super(`Gotenberg HTTP ${status}`);
  }
}
