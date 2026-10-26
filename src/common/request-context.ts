import type { Request } from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';

/** The request being served, for code too deep to be handed the auth context. */
const requestStorage = new AsyncLocalStorage<Request>();

export function runInRequestContext(request: Request, callback: () => void): void {
  requestStorage.run(request, callback);
}

/**
 * Role permissions of the user behind the current request, once the guards loaded them;
 * undefined outside a request (workers) or before that.
 */
export function currentRequestPermissions(): readonly string[] | undefined {
  return requestStorage.getStore()?.authContext?.permissions;
}
