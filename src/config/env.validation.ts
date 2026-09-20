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
  REDIS_URL: Joi.string()
    .trim()
    .uri({ scheme: ['redis', 'rediss'] })
    .required(),

  // Upload and media worker
  UPLOAD_SESSION_TTL_SECONDS: Joi.number().integer().min(1).required(),
  MAX_UPLOAD_SIZE_BYTES: Joi.number().integer().min(1).required(),
  MEDIA_WORKER_ENABLED: Joi.boolean().truthy('true').falsy('false').required(),

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
}).unknown(true);
