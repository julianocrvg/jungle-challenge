import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';
import { join } from 'node:path';

const SRC_DIR = join(import.meta.dir, '../../src');
const FLOAT = /\bnumber\b|parseFloat|\bNumber\(|\.toFixed\(|\bMath\./;
/** `version` é inteiro: some só o token `version: number` / `version as number`, não a linha (outro campo na mesma linha continua valendo). */
const VERSION_TOKEN = /[\w.]*[vV]ersion\w*\??(?::\s*number|\s+as\s+number)\b/g;
const MONEY = /\b(amount|balance|money|price|stake|payout)\b/i;

/** Linhas com tipo/conversão de ponto flutuante perto de um nome monetário (linha ou vizinhas); `version` é inteiro e fica fora (só o token). */
export function floatNearMoney(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const lines = code.split('\n');
  const hits: string[] = [];
  lines.forEach((line, i) => {
    const around = lines.slice(Math.max(0, i - 1), i + 2).join(' ');
    if (FLOAT.test(line.replace(VERSION_TOKEN, '')) && MONEY.test(around)) hits.push(`${i + 1}: ${line.trim()}`);
  });
  return hits;
}

describe('float scan over src/ (heuristic: float near a money name)', () => {
  test('detects bad snippets', () => {
    expect(floatNearMoney('const amount: number = 1;')).toHaveLength(1);
    expect(floatNearMoney('const balance = parseFloat(row.balance);')).toHaveLength(1);
    expect(floatNearMoney('const total = Number(money.amount);')).toHaveLength(1);
    expect(floatNearMoney('const s = price.toFixed(2);')).toHaveLength(1);
    expect(floatNearMoney('const stake = Math.round(x * 100);')).toHaveLength(1);
  });

  test('detects a float next to a version field on the same line', () => {
    expect(floatNearMoney('type W = { balance: number; version: number };')).toHaveLength(1);
    expect(floatNearMoney('type W = { version: number; balance: number };')).toHaveLength(1);
  });

  test('accepts integer version fields beside money names', () => {
    expect(floatNearMoney('balance: string;\n  version: number;')).toEqual([]);
    expect(floatNearMoney('version: row.version as number,')).toEqual([]);
    expect(floatNearMoney('balance: string; version: number;')).toEqual([]);
  });

  test('accepts good snippets (attempts, timeouts, comments)', () => {
    expect(floatNearMoney('const maxAttempts: number = 5;')).toEqual([]);
    expect(floatNearMoney('const timeoutMs: number = Number(process.env.T);')).toEqual([]);
    expect(floatNearMoney('const delay = Math.min(base * 2 ** attempt, max);')).toEqual([]);
    expect(floatNearMoney('// amount: number would be wrong\nconst x = 1;')).toEqual([]);
  });

  test('no float on money anywhere in src/', async () => {
    const offenders: string[] = [];
    for await (const scanned of new Glob('**/*.ts').scan(SRC_DIR)) {
      const path = scanned.replaceAll('\\', '/');
      for (const hit of floatNearMoney(await Bun.file(join(SRC_DIR, path)).text())) {
        offenders.push(`${path}:${hit}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
