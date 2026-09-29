/**
 * Jest global setup for db-spec tests.
 * Creates the test database if it does not exist, then runs all migrations.
 * Uses TEST_DATABASE_URL (default: postgres://postgres:postgres@localhost:55434/ag_go_test).
 */
import { Client } from 'pg';
import 'reflect-metadata';
import { AppDataSource } from './src/database/data-source';

const DEFAULT_URL = 'postgres://postgres:postgres@localhost:55434/ag_go_test';

export default async function globalSetup(): Promise<void> {
  const dbUrl = process.env['TEST_DATABASE_URL'] ?? DEFAULT_URL;

  // Parse the URL to connect to postgres db first (without the target db)
  const url = new URL(dbUrl);
  const dbName = url.pathname.replace(/^\//, '');
  url.pathname = '/postgres';

  const adminClient = new Client({ connectionString: url.toString() });
  await adminClient.connect();
  try {
    const { rows } = await adminClient.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname = $1`,
      [dbName],
    );
    if (rows.length === 0) {
      await adminClient.query(`CREATE DATABASE "${dbName}"`);
      console.log(`[jest.db-global-setup] Created database "${dbName}"`);
    }
  } finally {
    await adminClient.end();
  }

  // Run all migrations
  process.env['DATABASE_URL'] = dbUrl;
  process.env['DATABASE_SCHEMA'] = 'public';
  process.env['DATABASE_POOL_MAX'] = '2';
  process.env['NODE_ENV'] = process.env['NODE_ENV'] ?? 'test';

  // Ensure the data source picks up the test URL
  if (AppDataSource.isInitialized) {
    await AppDataSource.destroy();
  }

  // Re-init with test URL using direct options
  const ds = AppDataSource;
  // Patch the URL in options before initializing
  Object.assign(ds.options, { url: dbUrl, schema: 'public' });

  await ds.initialize();
  await ds.runMigrations({ transaction: 'each' });
  await ds.destroy();
  console.log('[jest.db-global-setup] Migrations applied to test database.');
}
