// This module never opens a connection. It must run before any test Pool is created.
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);
function parseLocal(value) {
  let u; try { u = new URL(value); } catch { throw new Error('TEST_DATABASE_URL_REQUIRED'); }
  if (!['postgres:', 'postgresql:'].includes(u.protocol) || !LOCAL.has(u.hostname)
      || !u.port || !u.username || !u.password || u.search || u.hash)
    throw new Error('TEST_DATABASE_TARGET_REJECTED');
  return u;
}
function assertTestDatabase(env = process.env) {
  if (env.APP_ENV !== 'test' || env.TEST_DB_ISOLATED !== 'true' || env.NODE_ENV === 'production')
    throw new Error('TEST_DATABASE_ENV_REJECTED');
  const u = parseLocal(env.TEST_DATABASE_URL);
  const name = u.pathname.slice(1);
  if (!/^review360_test_[a-z0-9_]{8,48}$/.test(name)) throw new Error('TEST_DATABASE_NAME_REJECTED');
  if (env.DATABASE_URL && env.DATABASE_URL !== env.TEST_DATABASE_URL)
    throw new Error('TEST_DATABASE_URL_MISMATCH');
  return u.toString();
}
function assertTestAdmin(env = process.env) {
  if (env.APP_ENV !== 'test' || env.TEST_DB_CREATE !== 'CONFIRMED_LOCAL_DISPOSABLE'
      || env.NODE_ENV === 'production') throw new Error('TEST_DATABASE_CREATE_NOT_CONFIRMED');
  const u = parseLocal(env.TEST_DATABASE_ADMIN_URL);
  if (u.pathname !== '/postgres') throw new Error('TEST_DATABASE_ADMIN_REJECTED');
  return u;
}
async function verifyTestConnection(db, env=process.env) {
  const target=new URL(assertTestDatabase(env));
  const {rows}=await db.query("SELECT current_database() AS name,shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()");
  if(rows[0]?.name!==target.pathname.slice(1)||rows[0]?.marker!=='review360 isolated test v1')
    throw new Error('TEST_DATABASE_SERVER_IDENTITY_REJECTED');
}
module.exports = { assertTestDatabase, assertTestAdmin, verifyTestConnection };
