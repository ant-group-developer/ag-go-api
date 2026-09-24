import Joi from 'joi';

const requiredString = Joi.string().trim().min(1).required();
const httpUrl = Joi.string()
  .trim()
  .uri({ scheme: ['http', 'https'] })
  .required();
const httpsUrl = Joi.string()
  .trim()
  .uri({ scheme: ['https'] })
  .required();

export const envValidationSchema = Joi.object({
  // Runtime
  NODE_ENV: Joi.string().valid('development', 'test', 'production').required(),
  PORT: Joi.number().integer().min(1).max(65535).required(),
  API_PREFIX: Joi.string()
    .trim()
    .pattern(/^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/)
    .required(),
  FRONTEND_ORIGIN: httpUrl,

  // PostgreSQL / Redis
  DATABASE_URL: Joi.string()
    .trim()
    .uri({ scheme: ['postgres', 'postgresql'] })
    .required(),
  DATABASE_SCHEMA: Joi.string()
    .trim()
    .pattern(/^[a-zA-Z_][a-zA-Z0-9_$]*$/)
    .required(),
  REDIS_URL: Joi.string()
    .trim()
    .uri({ scheme: ['redis', 'rediss'] })
    .required(),

  // Upload and media worker
  UPLOAD_SESSION_TTL_SECONDS: Joi.number().integer().min(1).required(),
  MAX_UPLOAD_SIZE_BYTES: Joi.number().integer().min(1).required(),
  MEDIA_WORKER_ENABLED: Joi.boolean().truthy('true').falsy('false').required(),
  QUEUE_PREFIX: requiredString,
  MEDIA_WORKER_CONCURRENCY: Joi.number().integer().min(1).max(32).required(),
  OUTBOX_POLL_INTERVAL_MS: Joi.number().integer().min(100).required(),
  MEDIA_JOB_ATTEMPTS: Joi.number().integer().min(1).max(20).required(),
  MEDIA_JOB_BACKOFF_MS: Joi.number().integer().min(100).required(),
  MEDIA_RENDER_TIMEOUT_SECONDS: Joi.number().integer().min(1).required(),
  MEDIA_THUMBNAIL_MAX_WIDTH: Joi.number().integer().min(1).required(),
  MEDIA_THUMBNAIL_MAX_HEIGHT: Joi.number().integer().min(1).required(),
  MEDIA_PREVIEW_MAX_WIDTH: Joi.number().integer().min(1).required(),
  MEDIA_PREVIEW_MAX_HEIGHT: Joi.number().integer().min(1).required(),

  // Cloudflare R2
  R2_ACCOUNT_ID: requiredString,
  R2_ACCESS_KEY_ID: requiredString,
  R2_SECRET_ACCESS_KEY: requiredString,
  R2_BUCKET: requiredString,
  R2_ENDPOINT: httpUrl,
  R2_PRESIGNED_URL_TTL_SECONDS: Joi.number().integer().min(1).required(),

  // Auth0
  AUTH0_ISSUER_URL: httpsUrl,
  AUTH0_AUDIENCE: requiredString,
  AUTH0_CLIENT_ID: requiredString,
  AUTH0_JWKS_URL: httpsUrl,

  // Account API
  ACCOUNT_API_URL: Joi.string()
    .trim()
    .uri({ scheme: ['http', 'https'] })
    .allow('')
    .optional(),
  ACCOUNT_API_KEY: Joi.string().trim().allow('').optional(),

  // Google Drive OAuth
  GOOGLE_CLIENT_ID: Joi.string().trim().allow('').optional(),
  GOOGLE_CLIENT_SECRET: Joi.string().trim().allow('').optional(),
  GOOGLE_REDIRECT_URI: Joi.string()
    .trim()
    .uri({ scheme: ['http', 'https'] })
    .allow('')
    .optional(),
  GOOGLE_SCOPES: Joi.string().trim().allow('').optional(),
  GOOGLE_TOKEN_ENCRYPTION_KEY: Joi.string().trim().allow('').optional(),
}).unknown(true);
