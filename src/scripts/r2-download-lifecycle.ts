import {
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
  S3ServiceException,
  type LifecycleRule,
} from '@aws-sdk/client-s3';
import 'dotenv/config';
import { DOWNLOAD_ZIP_PREFIX } from '../modules/downloads/download-naming';

/**
 * Sets the R2 lifecycle rule that deletes packed download ZIPs.
 *
 *   yarn r2:download-lifecycle              # expire after 1 day (the default)
 *   yarn r2:download-lifecycle --days 3
 *   yarn r2:download-lifecycle --dry-run    # print the rules without saving them
 *
 * A ZIP can be saved for `DOWNLOAD_ZIP_TTL_HOURS` after it is packed (`expiresAt` of the job),
 * so a day is the shortest rule R2 allows that never removes a ZIP someone may still save.
 * Other rules on the bucket are kept:
 * the S3 API replaces the whole configuration, so this reads it, swaps in its own rule by ID
 * and writes the lot back.
 */
const RULE_ID = 'ag-go-expire-download-zips';

function parseArgs(argv: string[]): { days: number; dryRun: boolean } {
  const daysIndex = argv.indexOf('--days');
  const days = daysIndex >= 0 ? Number(argv[daysIndex + 1]) : 1;
  if (!Number.isInteger(days) || days < 1) {
    throw new Error('--days must be a whole number of days, at least 1');
  }
  return { days, dryRun: argv.includes('--dry-run') };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

async function readRules(client: S3Client, bucket: string): Promise<LifecycleRule[]> {
  try {
    const result = await client.send(
      new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }),
    );
    return result.Rules ?? [];
  } catch (error) {
    if (error instanceof S3ServiceException && error.name === 'NoSuchLifecycleConfiguration') {
      return [];
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const { days, dryRun } = parseArgs(process.argv.slice(2));
  const bucket = requireEnv('R2_BUCKET');
  const client = new S3Client({
    region: 'auto',
    endpoint: requireEnv('R2_ENDPOINT'),
    credentials: {
      accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
    },
    forcePathStyle: true,
  });

  const rule: LifecycleRule = {
    ID: RULE_ID,
    Status: 'Enabled',
    Filter: { Prefix: DOWNLOAD_ZIP_PREFIX },
    Expiration: { Days: days },
    // A worker killed mid-upload leaves parts behind that no cancel ever aborts.
    AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
  };
  const rules = [...(await readRules(client, bucket)).filter((item) => item.ID !== RULE_ID), rule];

  console.log(`Lifecycle rules for bucket "${bucket}":`);
  console.log(JSON.stringify(rules, null, 2));
  if (dryRun) {
    console.log('Dry run: nothing saved.');
    return;
  }
  await client.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: bucket,
      LifecycleConfiguration: { Rules: rules },
    }),
  );
  console.log(`Saved: objects under "${DOWNLOAD_ZIP_PREFIX}" are deleted after ${days} day(s).`);
}

main().catch((error: unknown) => {
  if (error instanceof S3ServiceException && error.name === 'AccessDenied') {
    console.error(
      'R2 refused the bucket configuration. Bucket settings need an R2 API token with ' +
        '"Admin Read & Write"; an "Object Read & Write" token cannot change them. Run with an ' +
        'admin token in R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY, or add the rule in the ' +
        'Cloudflare dashboard.',
    );
  } else {
    console.error(error instanceof Error ? error.message : error);
  }
  process.exitCode = 1;
});
