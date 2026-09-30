import * as crypto from 'node:crypto';

export function computeHash(data: string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function generateMd5Hash(content: string): string {
  return crypto.createHash('md5').update(content).digest('hex');
}
