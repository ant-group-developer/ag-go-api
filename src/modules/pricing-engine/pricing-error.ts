export type PricingErrorCode = 'INVALID_AMOUNT' | 'INVALID_INPUT';

/** Invalid input to a pricing function; services map it to 400. */
export class PricingError extends Error {
  constructor(
    readonly code: PricingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PricingError';
  }
}
