import { describe, expect, test } from 'bun:test';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  ExternalTransactionIdConflictError,
  IdempotencyKeyConflictError,
  InvalidCommandError,
  TransientInfrastructureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../../src/application/errors';
import { DEFAULT_LOCK_TIMEOUT_MS, DEFAULT_POOL_MAX, databaseSettingsFromEnv } from '../../../src/config';
import {
  isTransientDatabaseError,
  uniqueViolationConstraint,
} from '../../../src/infrastructure/persistence/database-errors';
import { createOrmConfig } from '../../../src/infrastructure/persistence/mikro-orm.config';
import { toHttpError } from '../../../src/interface/http/http-error.filter';
import { RequestValidationError } from '../../../src/interface/http/validation';

describe('toHttpError: one mapping for every endpoint', () => {
  test.each([
    [new RequestValidationError(['x']), 400, 'INVALID_PAYLOAD'],
    [new InvalidCommandError('bad'), 400, 'INVALID_PAYLOAD'],
    [new BadRequestException('Unexpected end of JSON input'), 400, 'INVALID_PAYLOAD'],
    [new WalletNotFoundError('no'), 404, 'WALLET_NOT_FOUND'],
    [new NotFoundException('Cannot GET /nope'), 404, 'NOT_FOUND'],
    [new IdempotencyKeyConflictError('c'), 409, 'IDEMPOTENCY_KEY_CONFLICT'],
    [new ExternalTransactionIdConflictError('c'), 409, 'EXTERNAL_TRANSACTION_ID_CONFLICT'],
    [new WalletAlreadyExistsError('c'), 409, 'WALLET_ALREADY_EXISTS'],
    [new TransientInfrastructureError('down'), 503, 'SERVICE_UNAVAILABLE'],
    [new Error('boom'), 500, 'INTERNAL_ERROR'],
    ['not even an error', 500, 'INTERNAL_ERROR'],
  ])('%p -> %i %s', (error, status, code) => {
    const result = toHttpError(error);
    expect(result.status).toBe(status);
    expect(result.body.code).toBe(code);
  });

  test('only 503 carries Retry-After', () => {
    expect(toHttpError(new TransientInfrastructureError('down')).retryAfterSeconds).toBe(1);
    expect(toHttpError(new Error('boom')).retryAfterSeconds).toBeUndefined();
  });

  test('a 500 never exposes the internal message', () => {
    expect(toHttpError(new Error('relation "secret" does not exist')).body.message).toBe('Internal error');
  });
});

describe('database error classification', () => {
  const pg = (code: string, constraint?: string) => Object.assign(new Error('pg'), { code, constraint });

  test('reads the unique violation constraint by name, also through a wrapping cause', () => {
    expect(uniqueViolationConstraint(pg('23505', 'wt_provider_external_uq'))).toBe('wt_provider_external_uq');
    expect(uniqueViolationConstraint({ cause: pg('23505', 'wager_transactions_pkey') })).toBe('wager_transactions_pkey');
    expect(uniqueViolationConstraint(pg('23514', 'wt_amount_valid'))).toBeUndefined();
  });

  test.each(['40001', '40P01', '55P03', '57P01', '53300', '08006', '08001'])('%s is transient', (code) => {
    expect(isTransientDatabaseError(pg(code))).toBe(true);
  });

  test.each(['23505', '23514', '22P02', '42P01'])('%s is not transient', (code) => {
    expect(isTransientDatabaseError(pg(code))).toBe(false);
  });

  test('a refused connection is transient', () => {
    expect(isTransientDatabaseError(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }))).toBe(true);
  });
});

describe('database settings', () => {
  test('defaults: pool of at least 20 connections and a 10s lock_timeout', () => {
    const settings = databaseSettingsFromEnv({});
    expect(settings.poolMax).toBe(DEFAULT_POOL_MAX);
    expect(DEFAULT_POOL_MAX).toBeGreaterThanOrEqual(20);
    expect(settings.lockTimeoutMs).toBe(DEFAULT_LOCK_TIMEOUT_MS);
    expect(createOrmConfig('postgres://x').pool?.max).toBeGreaterThanOrEqual(20);
  });

  test('reads overrides from the environment and rejects invalid values', () => {
    expect(databaseSettingsFromEnv({ DB_POOL_MAX: '40', DB_LOCK_TIMEOUT_MS: '2500' })).toMatchObject({
      poolMax: 40, lockTimeoutMs: 2500,
    });
    expect(() => databaseSettingsFromEnv({ DB_LOCK_TIMEOUT_MS: '0' })).toThrow();
    expect(() => databaseSettingsFromEnv({ DB_LOCK_TIMEOUT_MS: "1000'; DROP TABLE wallets; --" })).toThrow();
    expect(() => databaseSettingsFromEnv({ DB_POOL_MAX: '1.5' })).toThrow();
  });
});
