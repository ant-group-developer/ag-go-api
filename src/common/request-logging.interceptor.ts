import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { catchError, tap, throwError } from 'rxjs';
import { SystemLogService } from '../modules/logs/system-log.service';

@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('http');

  constructor(private readonly systemLogs: SystemLogService) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const startedAt = Date.now();

    return next.handle().pipe(
      tap(() => {
        this.logRequest(request, response.statusCode, Date.now() - startedAt);
      }),
      catchError((error: unknown) => {
        const statusCode =
          typeof error === 'object' &&
          error !== null &&
          'status' in error &&
          typeof error.status === 'number'
            ? error.status
            : 500;
        this.logRequest(request, statusCode, Date.now() - startedAt, error);
        return throwError(() => error);
      }),
    );
  }

  private logRequest(
    request: Request,
    statusCode: number,
    durationMs: number,
    error?: unknown,
  ): void {
    const payload = {
      event: 'http_request',
      requestId: request.requestId,
      method: request.method,
      path: request.originalUrl.split('?')[0],
      statusCode,
      durationMs,
      ...(error ? { error: error instanceof Error ? error.message : 'request_failed' } : {}),
    };
    const message = JSON.stringify(payload);
    void this.systemLogs
      .writeHttp({
        requestId: request.requestId,
        userId: request.authContext?.userId ?? null,
        method: request.method,
        path: request.originalUrl.split('?')[0],
        statusCode,
        durationMs,
      })
      .catch((writeError: unknown) => {
        this.logger.warn(
          `Unable to persist HTTP log: ${
            writeError instanceof Error ? writeError.message : String(writeError)
          }`,
        );
      });
    if (statusCode >= 500) {
      this.logger.error(message);
    } else {
      this.logger.log(message);
    }
  }
}
