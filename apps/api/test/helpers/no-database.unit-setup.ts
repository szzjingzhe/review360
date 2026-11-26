import { vi } from 'vitest';
// Unit tests must inject query doubles. Accidental real pg access is always an error.
vi.mock('pg', () => ({ Pool: class { constructor(){throw new Error('UNIT_TEST_DATABASE_CONNECTION_FORBIDDEN');} }, Client: class { constructor(){throw new Error('UNIT_TEST_DATABASE_CONNECTION_FORBIDDEN');} } }));
