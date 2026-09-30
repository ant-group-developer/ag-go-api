/**
 * Origins allowed by CORS: ag-go-web (`FRONTEND_ORIGIN`, also where Google Drive sends the user back) plus
 * the other web apps that call this API with their user's token, e.g. ag-studio-web
 * (`CORS_EXTRA_ORIGINS`, comma-separated).
 */
export function corsOrigins(frontendOrigin: string, extraOrigins: string | undefined): string[] {
  const extra = (extraOrigins ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return [...new Set([frontendOrigin.trim().replace(/\/+$/, ''), ...extra])];
}
