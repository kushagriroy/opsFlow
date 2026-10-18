const path = require('node:path');
const { spawnSync } = require('node:child_process');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const configured = process.env.TEST_DATABASE_URL;
if (!configured) throw new Error('Refusing test migration: set TEST_DATABASE_URL explicitly.');

function databaseIdentity(value) {
  const url = new URL(value);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (database.toLowerCase() !== 'opsflow_test') throw new Error('Refusing test migration: database name must be exactly opsflow_test.');
  return `${url.protocol}//${url.hostname.toLowerCase()}:${url.port || '5432'}/${database.toLowerCase()}`;
}

const testIdentity = databaseIdentity(configured);
if (process.env.DATABASE_URL && testIdentity === databaseIdentity(process.env.DATABASE_URL)) {
  throw new Error('Refusing test migration: TEST_DATABASE_URL resolves to DATABASE_URL.');
}
if (process.env.NODE_ENV === 'production') throw new Error('Refusing test migration while NODE_ENV=production.');

const cli = path.resolve(__dirname, '../../../node_modules/prisma/build/index.js');
const result = spawnSync(process.execPath, [cli, 'migrate', 'deploy', '--schema', '../../prisma/schema.prisma'], {
  cwd: path.resolve(__dirname, '..'),
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: configured, NODE_ENV: 'test' },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
