import { QueryFailedError } from 'typeorm';

export const PgErrorCode = {
  STRING_TOO_LONG: '22001',
  NUMERIC_OUT_OF_RANGE: '22003',
  NOT_NULL_VIOLATION: '23502',
  FOREIGN_KEY_VIOLATION: '23503',
  UNIQUE_VIOLATION: '23505',
} as const;

export type PgErrorCodeValue = (typeof PgErrorCode)[keyof typeof PgErrorCode];

/** Extracts the SQLSTATE code from a TypeORM QueryFailedError, if present. */
export function pgErrorCodeOf(error: unknown): string | undefined {
  if (!(error instanceof QueryFailedError)) return undefined;

  const driverError: unknown = error.driverError;
  if (typeof driverError !== 'object' || driverError === null || !('code' in driverError)) {
    return undefined;
  }

  const { code } = driverError as { code: unknown };
  return typeof code === 'string' ? code : undefined;
}

/** Asserts that the operation rejects with a QueryFailedError carrying the given SQLSTATE. */
export async function expectPgError(
  operation: () => Promise<unknown>,
  code: PgErrorCodeValue,
): Promise<void> {
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(QueryFailedError);
  expect(pgErrorCodeOf(caught)).toBe(code);
}
