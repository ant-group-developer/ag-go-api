import { CallHandler, ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { map, type Observable } from 'rxjs';
import { ApiResponseDto } from './dto/api-response.dto';

@Injectable()
export class ApiResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    return next.handle().pipe(
      map((data: unknown) => {
        if (this.shouldSkip(request, response) || this.isApiResponse(data)) {
          return data;
        }

        return new ApiResponseDto(
          data ?? null,
          request.requestId ?? String(response.getHeader('x-request-id') ?? ''),
          true,
        );
      }),
    );
  }

  private shouldSkip(request: Request, response: Response): boolean {
    if (
      response.headersSent ||
      response.statusCode === 204 ||
      request.originalUrl.replace(/\?.*$/, '').endsWith('/openapi.json')
    ) {
      return true;
    }

    const contentType = response.getHeader('content-type');
    return typeof contentType === 'string' && !contentType.includes('json');
  }

  private isApiResponse(value: unknown): value is ApiResponseDto<unknown> {
    if (!value || typeof value !== 'object') {
      return false;
    }

    const candidate = value as Record<string, unknown>;
    return (
      typeof candidate.requestId === 'string' &&
      typeof candidate.timestamp === 'string' &&
      typeof candidate.success === 'boolean' &&
      'data' in candidate &&
      'error' in candidate
    );
  }
}
