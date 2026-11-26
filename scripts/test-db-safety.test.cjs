const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertTestDatabase, assertTestAdmin } = require('./test-db-safety.cjs');
const good = { APP_ENV: 'test', TEST_DB_ISOLATED: 'true', TEST_DATABASE_URL: 'postgres://test:secret@127.0.0.1:55433/review360_test_12345678' };
test('accept explicit isolated local database', () => assert.ok(assertTestDatabase(good)));
for (const [name, patch] of Object.entries({ missing: { TEST_DATABASE_URL: '' }, business: { TEST_DATABASE_URL: 'postgres://test:secret@127.0.0.1:55433/review360' }, remote: { TEST_DATABASE_URL: 'postgres://test:secret@example.com:5432/review360_test_12345678' }, production: { APP_ENV: 'production' }, marker: { TEST_DB_ISOLATED: '' }, mismatch: { DATABASE_URL: 'postgres://test:secret@localhost:5432/review360' }, options: { TEST_DATABASE_URL: good.TEST_DATABASE_URL + '?host=evil' } })) {
 test('reject ' + name + ' before connection', () => assert.throws(() => assertTestDatabase({ ...good, ...patch })));
}
test('creation requires explicit confirmation', () => assert.throws(() => assertTestAdmin({ APP_ENV: 'test' })));
test('creation accepts only confirmed local maintenance database', () => assert.ok(assertTestAdmin({ APP_ENV: 'test', TEST_DB_CREATE: 'CONFIRMED_LOCAL_DISPOSABLE', TEST_DATABASE_ADMIN_URL: 'postgres://test:secret@localhost:55433/postgres' })));

const {spawnSync}=require('node:child_process');
const {resolve}=require('node:path');
for(const script of ['test-db-setup.cjs','test-isolated.cjs','create-db.js','recreate-db.js']) {
 test('unconfigured '+script+' exits safely',()=>{
   const env={...process.env};for(const key of ['APP_ENV','DATABASE_URL','TEST_DATABASE_URL','TEST_DATABASE_ADMIN_URL','TEST_DB_CREATE','TEST_DB_ISOLATED'])delete env[key];
   const result=spawnSync(process.execPath,[resolve(__dirname,script)],{env,encoding:'utf8'});
   assert.notEqual(result.status,0);
   assert.match(result.stderr,/TEST_DATABASE_|UNSAFE_LEGACY_DATABASE_SCRIPT_DISABLED/);
 });
}

const {verifyTestConnection}=require('./test-db-safety.cjs');
test('server marker and actual database must match before writes',async()=>{
 for(const row of [{name:'review360',marker:'review360 isolated test v1'},{name:'review360_test_12345678',marker:null}])
   await assert.rejects(verifyTestConnection({query:async()=>({rows:[row]})},good),/SERVER_IDENTITY_REJECTED/);
 await verifyTestConnection({query:async()=>({rows:[{name:'review360_test_12345678',marker:'review360 isolated test v1'}]})},good);
});
