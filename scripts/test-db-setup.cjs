const { assertTestDatabase } = require('./test-db-safety.cjs');
process.env.DATABASE_URL = assertTestDatabase();
// Never inherit the working project's .env in an integration suite.
process.env.NODE_ENV = 'test';
process.env.APP_ORIGIN = 'http://localhost:5173';
process.env.ORG_TIMEZONE = 'Asia/Shanghai';
process.env.DEMO_LOGIN_ENABLED = 'true';
process.env.SESSION_SECRET = 'isolated-test-session-secret-not-for-production';

