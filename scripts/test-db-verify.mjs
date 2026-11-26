import './test-db-setup.cjs';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const { assertTestDatabase }=require('./test-db-safety.cjs');
const { Pool }=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const target=new URL(assertTestDatabase());
const pool=new Pool({connectionString:target.toString(),connectionTimeoutMillis:5000});
try { await require('./test-db-safety.cjs').verifyTestConnection(pool); } finally { await pool.end(); }
