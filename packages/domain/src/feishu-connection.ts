import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { DbClient } from './db.js';

export interface FeishuConnection {
  appId: string;
  secret: string;
  tenantKey: string;
}

function key(value: string) {
  return createHash('sha256').update('review360:feishu:').update(value).digest();
}

export function encryptFeishuSecret(secret: string, master: string, orgId: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(master), iv);
  cipher.setAAD(Buffer.from(orgId));
  const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map(part => part.toString('base64url')).join('.');
}

export async function readFeishuConnection(db: DbClient, orgId: string, master: string): Promise<FeishuConnection | null> {
  const row = (await db.query<{app_id: string; tenant_key: string; encrypted_secret: string}>(
    'SELECT app_id, tenant_key, encrypted_secret FROM feishu_connections WHERE org_id=$1', [orgId],
  )).rows[0];
  if (!row) return null;
  const [iv, tag, data] = row.encrypted_secret.split('.').map(part => Buffer.from(part, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', key(master), iv);
  decipher.setAAD(Buffer.from(orgId));
  decipher.setAuthTag(tag);
  return { appId: row.app_id, tenantKey: row.tenant_key, secret: Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8') };
}
