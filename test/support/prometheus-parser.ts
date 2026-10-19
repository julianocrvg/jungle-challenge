/*
 * Parser ESTRITO do formato texto do Prometheus (versão 0.0.4), para os testes de /metrics. Rejeita (lança) tudo que
 * um scraper rigoroso rejeitaria: TYPE duplicado ou depois das amostras, família que volta depois de outra,
 * série repetida, label malformado ou duplicado, escape inválido, histograma com buckets fora de ordem, não
 * cumulativos, sem `+Inf` ou com `+Inf` diferente de `_count`.
 */

export type ParsedType = 'counter' | 'gauge' | 'histogram';

export interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

export interface ParsedFamily {
  name: string;
  type: ParsedType;
  help?: string;
  samples: Sample[];
}

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function parseValue(text: string, where: string): number {
  if (text === 'NaN') return Number.NaN;
  if (text === '+Inf' || text === 'Inf') return Number.POSITIVE_INFINITY;
  if (text === '-Inf') return Number.NEGATIVE_INFINITY;
  if (!NUMBER.test(text)) throw new Error(`${where}: invalid sample value "${text}"`);
  return Number(text);
}

/** Lê `{a="x",b="y"}` a partir de `start` (o `{`); devolve os labels e o índice depois do `}`. */
function parseLabels(line: string, start: number, where: string): { labels: Record<string, string>; end: number } {
  const labels: Record<string, string> = {};
  let i = start + 1;
  if (line[i] === '}') return { labels, end: i + 1 };
  for (;;) {
    const eq = line.indexOf('=', i);
    if (eq === -1) throw new Error(`${where}: label without "="`);
    const name = line.slice(i, eq);
    if (!LABEL_NAME.test(name)) throw new Error(`${where}: invalid label name "${name}"`);
    if (name in labels) throw new Error(`${where}: duplicate label "${name}"`);
    if (line[eq + 1] !== '"') throw new Error(`${where}: label value of "${name}" is not quoted`);
    let value = '';
    let j = eq + 2;
    for (;;) {
      const c = line[j];
      if (c === undefined) throw new Error(`${where}: unterminated label value`);
      if (c === '\\') {
        const next = line[j + 1];
        if (next === '\\') value += '\\';
        else if (next === '"') value += '"';
        else if (next === 'n') value += '\n';
        else throw new Error(`${where}: invalid escape "\\${next}" in label value`);
        j += 2;
      } else if (c === '"') {
        j++;
        break;
      } else if (c === '\n') {
        throw new Error(`${where}: raw newline in label value`);
      } else {
        value += c;
        j++;
      }
    }
    labels[name] = value;
    if (line[j] === ',') {
      i = j + 1;
      if (line[i] === '}') throw new Error(`${where}: trailing comma in labels`);
      continue;
    }
    if (line[j] === '}') return { labels, end: j + 1 };
    throw new Error(`${where}: unexpected "${line[j]}" after label value`);
  }
}

function familyOf(sampleName: string, families: Map<string, ParsedFamily>): ParsedFamily | undefined {
  const direct = families.get(sampleName);
  if (direct !== undefined && direct.type !== 'histogram') return direct;
  for (const suffix of ['_bucket', '_sum', '_count']) {
    if (sampleName.endsWith(suffix)) {
      const base = families.get(sampleName.slice(0, -suffix.length));
      if (base?.type === 'histogram') return base;
    }
  }
  return undefined;
}

const seriesKey = (name: string, labels: Record<string, string>): string =>
  `${name}{${Object.keys(labels).sort().map((k) => `${k}=${JSON.stringify(labels[k])}`).join(',')}}`;

export function parsePrometheus(text: string): Map<string, ParsedFamily> {
  if (text === '') return new Map();
  if (!text.endsWith('\n')) throw new Error('exposition must end with a newline');
  const families = new Map<string, ParsedFamily>();
  const seenSeries = new Set<string>();
  const closed = new Set<string>(); // famílias que já terminaram (outra começou)
  let current: ParsedFamily | undefined;
  const pendingHelp = new Map<string, string>();

  const lines = text.slice(0, -1).split('\n');
  lines.forEach((line, index) => {
    const where = `line ${index + 1}`;
    if (line === '') throw new Error(`${where}: blank line`);

    if (line.startsWith('#')) {
      const help = /^# HELP ([a-zA-Z_:][a-zA-Z0-9_:]*) (.*)$/.exec(line);
      const type = /^# TYPE ([a-zA-Z_:][a-zA-Z0-9_:]*) (counter|gauge|histogram)$/.exec(line);
      if (help !== null) {
        const [, name, body] = help as unknown as [string, string, string];
        if (families.has(name)) throw new Error(`${where}: HELP for ${name} after its TYPE`);
        if (pendingHelp.has(name)) throw new Error(`${where}: duplicate HELP for ${name}`);
        if (/\\(?![\\n])/.test(body)) throw new Error(`${where}: invalid escape in HELP`);
        pendingHelp.set(name, body);
        return;
      }
      if (type !== null) {
        const [, name, kind] = type as unknown as [string, string, ParsedType];
        if (families.has(name)) throw new Error(`${where}: duplicate TYPE for ${name}`);
        if (!NAME.test(name)) throw new Error(`${where}: invalid metric name`);
        if (kind === 'counter' && !name.endsWith('_total')) throw new Error(`${where}: counter ${name} must end with _total`);
        if (current !== undefined) closed.add(current.name);
        const family: ParsedFamily = { name, type: kind, samples: [], ...(pendingHelp.has(name) ? { help: pendingHelp.get(name)! } : {}) };
        pendingHelp.delete(name);
        families.set(name, family);
        current = family;
        return;
      }
      throw new Error(`${where}: unsupported comment "${line}"`);
    }

    const nameMatch = /^[a-zA-Z_:][a-zA-Z0-9_:]*/.exec(line);
    if (nameMatch === null) throw new Error(`${where}: sample without a valid name`);
    const name = nameMatch[0];
    let labels: Record<string, string> = {};
    let rest = line.slice(name.length);
    if (rest.startsWith('{')) {
      const parsed = parseLabels(line, name.length, where);
      labels = parsed.labels;
      rest = line.slice(parsed.end);
    }
    if (!rest.startsWith(' ') || rest.slice(1).includes(' ')) throw new Error(`${where}: expected "name{labels} value"`);
    const value = parseValue(rest.slice(1), where);

    const family = familyOf(name, families);
    if (family === undefined) throw new Error(`${where}: sample ${name} has no TYPE`);
    if (family !== current) {
      if (closed.has(family.name)) throw new Error(`${where}: family ${family.name} is not contiguous`);
      throw new Error(`${where}: sample ${name} outside its family block`);
    }
    const key = seriesKey(name, labels);
    if (seenSeries.has(key)) throw new Error(`${where}: duplicate series ${key}`);
    seenSeries.add(key);
    if (family.type === 'counter' && !(value >= 0)) throw new Error(`${where}: negative counter`);
    if (name.endsWith('_bucket') && !('le' in labels)) throw new Error(`${where}: bucket without le`);
    if (family.type !== 'histogram' && 'le' in labels) throw new Error(`${where}: "le" is reserved for histograms`);
    family.samples.push({ name, labels, value });
  });

  for (const name of pendingHelp.keys()) throw new Error(`HELP for ${name} without TYPE`);
  for (const family of families.values()) {
    if (family.type === 'histogram') validateHistogram(family);
  }
  return families;
}

function validateHistogram(family: ParsedFamily): void {
  const groups = new Map<string, { buckets: { le: number; value: number }[]; sum?: number; count?: number }>();
  for (const sample of family.samples) {
    const { le, ...rest } = sample.labels;
    const key = seriesKey(family.name, rest);
    const group = groups.get(key) ?? { buckets: [] };
    groups.set(key, group);
    if (sample.name === `${family.name}_bucket`) {
      group.buckets.push({ le: parseValue(le!, family.name), value: sample.value });
    } else if (sample.name === `${family.name}_sum`) {
      if (group.sum !== undefined) throw new Error(`${key}: duplicate _sum`);
      group.sum = sample.value;
    } else if (sample.name === `${family.name}_count`) {
      if (group.count !== undefined) throw new Error(`${key}: duplicate _count`);
      group.count = sample.value;
    } else {
      throw new Error(`${key}: unexpected histogram sample ${sample.name}`);
    }
  }
  for (const [key, group] of groups) {
    if (group.sum === undefined || group.count === undefined) throw new Error(`${key}: histogram needs _sum and _count`);
    if (group.buckets.length === 0) throw new Error(`${key}: histogram without buckets`);
    for (let i = 1; i < group.buckets.length; i++) {
      if (!(group.buckets[i]!.le > group.buckets[i - 1]!.le)) throw new Error(`${key}: le not strictly increasing`);
      if (group.buckets[i]!.value < group.buckets[i - 1]!.value) throw new Error(`${key}: buckets are not cumulative`);
    }
    const last = group.buckets.at(-1)!;
    if (last.le !== Number.POSITIVE_INFINITY) throw new Error(`${key}: last bucket must be +Inf`);
    if (last.value !== group.count) throw new Error(`${key}: +Inf bucket (${last.value}) differs from _count (${group.count})`);
  }
}

/** O valor de uma amostra (por nome e labels exatos), ou `undefined`. */
export function sampleValue(families: Map<string, ParsedFamily>, name: string, labels: Record<string, string> = {}): number | undefined {
  const key = seriesKey(name, labels);
  for (const family of families.values()) {
    for (const sample of family.samples) if (seriesKey(sample.name, sample.labels) === key) return sample.value;
  }
  return undefined;
}

/** A soma de um counter por todos os labels que casam com `match`. */
export function sumWhere(families: Map<string, ParsedFamily>, name: string, match: Record<string, string> = {}): number {
  let total = 0;
  for (const family of families.values()) {
    for (const s of family.samples) {
      if (s.name === name && Object.entries(match).every(([k, v]) => s.labels[k] === v)) total += s.value;
    }
  }
  return total;
}
