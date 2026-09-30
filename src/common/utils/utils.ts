import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);

export function chunkArray<T>(array: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(array.length / size) }, (v, i) =>
    array.slice(i * size, i * size + size),
  );
}

export async function saveAsGzip(data: unknown, filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });

  const content = typeof data === 'string' ? data : JSON.stringify(data);
  const compressedBuffer = await gzipAsync(Buffer.from(content, 'utf-8'));

  await writeFile(filePath, compressedBuffer);
}
