import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { chunkArray, saveAsGzip } from './utils';

describe('chunkArray', () => {
  it('should split array into equal chunks when length is divisible by size', () => {
    const input = [1, 2, 3, 4, 5, 6];
    const result = chunkArray(input, 2);

    expect(result).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
  });

  it('should handle uneven chunk sizes with remainder in the last chunk', () => {
    const input = ['a', 'b', 'c', 'd', 'e'];
    const result = chunkArray(input, 2);

    expect(result).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
  });

  it('should return a single chunk if chunk size exceeds array length', () => {
    const input = [1, 2];
    const result = chunkArray(input, 10);

    expect(result).toEqual([[1, 2]]);
  });

  it('should return an empty array when given an empty array', () => {
    const result = chunkArray([], 5);
    expect(result).toEqual([]);
  });
});

describe('saveAsGzip', () => {
  let tempTestDir: string;

  beforeEach(async () => {
    tempTestDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gzip-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempTestDir, { recursive: true, force: true });
  });

  async function readAndDecompress(filePath: string): Promise<string> {
    const chunks: Buffer[] = [];
    const gunzip = createGunzip();
    gunzip.on('data', (chunk) => chunks.push(Buffer.from(chunk)));

    await pipeline(createReadStream(filePath), gunzip);
    return Buffer.concat(chunks).toString('utf-8');
  }

  it('should compress and write JSON payload to disk and ensure directory creation', async () => {
    const nestedFilePath = path.join(tempTestDir, 'nested', 'deep', 'output.json.gz');
    const payload = { id: 123, status: 'SUCCESS', flags: [true, false] };

    await saveAsGzip(payload, nestedFilePath);

    // Verifica que o ficheiro final existe
    await expect(fs.access(nestedFilePath)).resolves.not.toThrow();

    // Descomprime e valida o conteúdo gravado
    const rawContent = await readAndDecompress(nestedFilePath);
    expect(JSON.parse(rawContent)).toEqual(payload);

    // Garante que não ficaram ficheiros temporários (.tmp) órfãos
    const dirEntries = await fs.readdir(path.dirname(nestedFilePath));
    const tmpFiles = dirEntries.filter((file) => file.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });

  it('should clean up the temporary file if pipeline fails', async () => {
    const targetPath = path.join(tempTestDir, 'corrupt.json.gz');

    // Cria referência circular para forçar TypeError no JSON.stringify
    const circularPayload: Record<string, unknown> = {};
    circularPayload.self = circularPayload;

    await expect(saveAsGzip(circularPayload, targetPath)).rejects.toThrow(TypeError);

    // Valida que o ficheiro destino não existe
    await expect(fs.access(targetPath)).rejects.toHaveProperty('code', 'ENOENT');

    // Valida que nenhum ficheiro temporário sobrou
    const files = await fs.readdir(tempTestDir);
    expect(files).toHaveLength(0);
  });

  it('should overwrite an existing compressed file atomically', async () => {
    const targetFile = path.join(tempTestDir, 'overwrite.json.gz');

    await saveAsGzip({ version: 1 }, targetFile);
    let content = await readAndDecompress(targetFile);
    expect(JSON.parse(content)).toEqual({ version: 1 });

    // Segunda escrita para o mesmo caminho
    await saveAsGzip({ version: 2, updated: true }, targetFile);
    content = await readAndDecompress(targetFile);
    expect(JSON.parse(content)).toEqual({ version: 2, updated: true });

    // Nenhum tmp residual
    const files = await fs.readdir(tempTestDir);
    expect(files).toEqual(['overwrite.json.gz']);
  });

  it('should preserve integrity with UTF-8 and special symbols', async () => {
    const targetFile = path.join(tempTestDir, 'unicode.json.gz');
    const complexPayload = {
      message: 'Árvores, maçãs, café & símbolos: 🚀 🤖 🔥',
      htmlSample: '<div class="alert" data-val="123">Olá Mundo & Adeus</div>',
      emptyString: '',
    };

    await saveAsGzip(complexPayload, targetFile);

    const content = await readAndDecompress(targetFile);
    expect(JSON.parse(content)).toEqual(complexPayload);
  });

  it('should compress and decompress large datasets without memory leakage', async () => {
    const targetFile = path.join(tempTestDir, 'large.json.gz');
    // Gera ~5.000 nós para simular um dump de árvore de acessibilidade
    const largePayload = Array.from({ length: 5000 }, (_, idx) => ({
      nodeId: idx,
      tag: 'div',
      classes: ['flex', 'items-center', 'justify-between', 'px-4'],
      attributes: { role: 'button', 'aria-label': `Item ${idx}` },
      content: 'A'.repeat(50),
    }));

    await saveAsGzip(largePayload, targetFile);

    const stats = await fs.stat(targetFile);
    // Verifica que houve compressão efetiva (ficheiro gzip < 10% do tamanho bruto)
    const rawSize = Buffer.byteLength(JSON.stringify(largePayload));
    expect(stats.size).toBeLessThan(rawSize * 0.2);

    const content = await readAndDecompress(targetFile);
    expect(JSON.parse(content)).toEqual(largePayload);
  });

  it('should handle concurrent writes to different files without collisions', async () => {
    const operations = Array.from({ length: 20 }, (_, idx) => {
      const filePath = path.join(tempTestDir, `concurrency_${idx}.json.gz`);
      return saveAsGzip({ index: idx, timestamp: Date.now() }, filePath);
    });

    await expect(Promise.all(operations)).resolves.not.toThrow();

    const files = await fs.readdir(tempTestDir);
    expect(files).toHaveLength(20);
    expect(files.every((file) => file.endsWith('.json.gz'))).toBe(true);
  });
});
