import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { ApiResponseInterceptor } from './api-response.interceptor';
import { RawResponse } from './raw-response.decorator';

class SampleController {
  wrapped() {
    return { value: 1 };
  }

  @RawResponse()
  raw() {
    return { results: [{ op: 'get', url: 'https://example.com/file' }] };
  }
}

function run(handler: 'wrapped' | 'raw'): Promise<unknown> {
  const request = { requestId: 'req-1', originalUrl: `/api/${handler}` };
  const response = { headersSent: false, statusCode: 200, getHeader: () => undefined };
  const context = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    getHandler: () => SampleController.prototype[handler],
    getClass: () => SampleController,
  } as unknown as ExecutionContext;
  const next: CallHandler = { handle: () => of(new SampleController()[handler]()) };
  return lastValueFrom(new ApiResponseInterceptor(new Reflector()).intercept(context, next));
}

describe('ApiResponseInterceptor', () => {
  it('wraps a route in the API envelope', async () => {
    await expect(run('wrapped')).resolves.toMatchObject({
      success: true,
      data: { value: 1 },
      requestId: 'req-1',
    });
  });

  it('leaves a @RawResponse() route as the handler returned it', async () => {
    await expect(run('raw')).resolves.toEqual({
      results: [{ op: 'get', url: 'https://example.com/file' }],
    });
  });
});
