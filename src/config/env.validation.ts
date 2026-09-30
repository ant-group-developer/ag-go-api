import Joi from 'joi';

/**
 * How long a query waits to connect or for a free pool slot before it fails. Without it a pool
 * held up (for example by transactions each waiting for a second connection) hangs forever.
 */
export const DATABASE_CONNECT_TIMEOUT_MS = 10_000;

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
  // Connections per process. Every api and worker process on every host has its own pool,
  // and together they must stay under Postgres' max_connections (docker-compose.yml gives
  // the workers WORKER_DATABASE_POOL_MAX). Defaulted so existing .env files keep working.
  DATABASE_POOL_MAX: Joi.number().integer().min(1).max(200).default(10),
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
  // Threads per FFmpeg/sharp run; keep it near WORKER_CPUS. Defaulted so existing .env files keep working.
  MEDIA_FFMPEG_THREADS: Joi.number().integer().min(1).max(64).default(2),
  OUTBOX_POLL_INTERVAL_MS: Joi.number().integer().min(100).required(),
  MEDIA_JOB_ATTEMPTS: Joi.number().integer().min(1).max(20).required(),
  MEDIA_JOB_BACKOFF_MS: Joi.number().integer().min(100).required(),
  // Limit for ffprobe/thumbnail runs, and the minimum for a video preview render, whose budget
  // grows with the source length (a stuck preview render is killed by its stall check instead).
  MEDIA_RENDER_TIMEOUT_SECONDS: Joi.number().integer().min(1).required(),
  MEDIA_THUMBNAIL_MAX_WIDTH: Joi.number().integer().min(1).required(),
  MEDIA_PREVIEW_MAX_WIDTH: Joi.number().integer().min(1).required(),

  // Cloudflare R2
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
  // Comma-separated list of allowed Auth0 client IDs (azp claim).
  // When set, overrides AUTH0_CLIENT_ID for azp validation.
  // Allows multiple SPA apps (ag-go-web, ag-studio-web, ag-farm-web) to share this API.
  AUTH0_ALLOWED_CLIENT_IDS: Joi.string().trim().allow('').optional(),

  // Service-key authentication for backend-to-backend calls (e.g. ag-studio acting as user)
  // JSON array: [{"name":"studio","sha256":"<hex-of-sha256(key)>","scopes":["footage:read","footage:resolve"]}]
  SERVICE_KEYS: Joi.string().trim().allow('').optional(),

  // Account API path template for looking up user_type + permissions by userId.
  // {userId} is replaced with the encoded userId.
  ACCOUNT_API_USER_ACCESS_PATH: Joi.string().trim().allow('').optional(),
  ACCOUNT_APPLICATION_CODE: Joi.string().trim().allow('').optional(),

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

  // ag-farm integration
  FARM_URL: Joi.string()
    .trim()
    .uri({ scheme: ['http', 'https'] })
    .allow('')
    .optional(),
  FARM_OWNER_KEY: Joi.string().trim().allow('').optional(),
  // PEM public key for verifying farm tickets; accept literal \n in the value
  FARM_TICKET_PUBLIC_KEY: Joi.string().trim().allow('').optional(),
  FARM_URL_TTL_SECONDS: Joi.number().integer().min(1).default(3600),
  FARM_POLL_INTERVAL_MS: Joi.number().integer().min(100).default(5000),

  // Content analysis
  ANALYSIS_AUTO_ENQUEUE: Joi.boolean().truthy('true').falsy('false').default(false),
  ANALYSIS_EXTRACT_VERSION: Joi.string().trim().min(1).default('x1'),
  ANALYSIS_PROMPT_VERSION: Joi.string().trim().min(1).default('p1'),
  ANALYSIS_MODEL: Joi.string().trim().min(1).default('qwen2.5vl:7b'),
}).unknown(true);
