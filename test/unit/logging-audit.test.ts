import { describe, expect, test } from 'bun:test';

/*
 * Teste arquitetural (ARCHITECTURE 11.2), rede secundária da auditoria de logs. A rede principal é a de runtime
 * (o afterEach "nenhum valor monetário em log" e os testes do filtro HTTP). Aqui, em todo `src/`, um argumento de
 * chamada de logger não pode conter
 *   1. acesso a `.message` ou `.stack`;
 *   2. uma variável de `catch` (ou parâmetro de `.catch(...)`), direta ou dentro de template, `String()`,
 *      `JSON.stringify()` ou spread, fora de `errorFields()` / `describeError()`, as únicas funções que filtram erro.
 *
 * Não é uma AST: o `typescript` 7 (port nativo) não expõe a API de compilador em JS, e não se adiciona dependência
 * só para isto. É um varredor de texto com comentários e strings mascarados e parênteses balanceados. Limites: o
 * escopo de uma variável de catch é o arquivo inteiro (pode acusar de mais, nunca de menos) e um erro repassado
 * por uma variável intermediária (`const e2 = error; logger.warn(e2)`) não é visto; para isso vale a rede de runtime.
 */

const LOGGER_CALL = /\b[\w.]*[Ll]ogger\.(?:info|warn|error|log|debug|verbose|fatal)\s*\(/g;
const SAFE_CALL = /\b(?:errorFields|describeError)\s*\(/g;
const CATCH_NAMES = [/\bcatch\s*\(\s*(\w+)/g, /\.catch\(\s*(?:async\s*)?\(?\s*(\w+)/g];

export interface Leak {
  line: number;
  reason: string;
}

/** Mesmo tamanho do original, com comentários e o texto de strings/templates trocados por espaços (`${}` fica). */
export function mask(source: string): string {
  const out = source.split('');
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  const templates: number[] = []; // profundidade de chaves aberta dentro de cada `${`
  let i = 0;
  const readTemplateText = (): void => {
    const start = i;
    while (i < source.length && source[i] !== '`' && !(source[i] === '$' && source[i + 1] === '{')) {
      i += source[i] === '\\' ? 2 : 1;
    }
    blank(start, i);
    if (source[i] === '$') {
      templates.push(0);
      i += 2;
    } else {
      i++; // fecha o template
    }
  };
  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      const start = ++i;
      while (i < source.length && source[i] !== c && source[i] !== '\n') i += source[i] === '\\' ? 2 : 1;
      blank(start, i);
      i++;
    } else if (c === '`') {
      i++;
      readTemplateText();
    } else if (templates.length > 0 && c === '{') {
      templates[templates.length - 1]!++;
      i++;
    } else if (templates.length > 0 && c === '}') {
      if (templates[templates.length - 1] === 0) {
        templates.pop();
        i++;
        readTemplateText(); // volta ao texto do template
      } else {
        templates[templates.length - 1]!--;
        i++;
      }
    } else {
      i++;
    }
  }
  return out.join('');
}

/** Índice do `)` que fecha o `(` em `open`. */
function closing(text: string, open: number): number {
  let depth = 0;
  for (let k = open; k < text.length; k++) {
    if (text[k] === '(') depth++;
    else if (text[k] === ')' && --depth === 0) return k;
  }
  return text.length;
}

function blankSafeCalls(args: string): string {
  const chars = args.split('');
  for (const match of args.matchAll(SAFE_CALL)) {
    const open = match.index! + match[0].length - 1;
    const end = closing(args, open);
    for (let k = match.index!; k <= end && k < chars.length; k++) if (chars[k] !== '\n') chars[k] = ' ';
  }
  return chars.join('');
}

export function findLoggerLeaks(source: string): Leak[] {
  const code = mask(source);
  const caught = new Set<string>();
  for (const pattern of CATCH_NAMES) for (const match of code.matchAll(pattern)) caught.add(match[1]!);

  const leaks: Leak[] = [];
  const lineAt = (index: number): number => source.slice(0, index).split('\n').length;
  for (const call of code.matchAll(LOGGER_CALL)) {
    const open = call.index! + call[0].length - 1;
    // `...error` (spread): sem os pontos, o `(?<![.\w])` abaixo não confundiria o spread com `x.error`.
    const args = blankSafeCalls(code.slice(open + 1, closing(code, open))).replaceAll('...', '   ');
    for (const match of args.matchAll(/\.(message|stack)\b/g)) {
      leaks.push({ line: lineAt(open + 1 + match.index!), reason: `.${match[1]} em argumento de logger` });
    }
    for (const name of caught) {
      // `(?!\s*:)` descarta a chave de propriedade (`{ error: 1 }`); `(?<![.\w])` descarta `x.error`.
      for (const match of args.matchAll(new RegExp(`(?<![.\\w])${name}(?!\\w)(?!\\s*:)`, 'g'))) {
        leaks.push({ line: lineAt(open + 1 + match.index!), reason: `variável de catch "${name}" em argumento de logger` });
      }
    }
  }
  return leaks;
}

describe('o detector de vazamentos em logs reconhece o que procura', () => {
  const wrap = (body: string): string => `try {} catch (error) { ${body} }`;

  test.each([
    ['.message', wrap('this.logger.warn("x", { detail: error.message });')],
    ['.stack', wrap('this.logger.error("x", { stack: error.stack });')],
    ['variável de catch direta', wrap('this.logger.error("x", { error });')],
    ['template', wrap('this.logger.error(`failed: ${error}`);')],
    ['template com chaves aninhadas', wrap('this.logger.error(`a ${ {k: 1}.k } b ${error}`);')],
    ['String()', wrap('this.logger.error("x", { detail: String(error) });')],
    ['JSON.stringify()', wrap('logger.error("x", { detail: JSON.stringify(error) });')],
    ['spread', wrap('this.logger.warn("x", { ...error });')],
    ['.catch(callback)', 'promise.catch((e) => this.logger.warn("x", { e }));'],
    ['.message de uma variável qualquer', 'this.logger.info("x", { v: result.message });'],
    ['ao lado de errorFields', wrap('this.logger.error("x", { ...errorFields(error), also: error.message });')],
    ['em várias linhas', wrap('this.logger.error(\n  "x",\n  {\n    detail: error.message,\n  },\n);')],
  ])('detecta %s', (_name, source) => {
    expect(findLoggerLeaks(source).length).toBeGreaterThan(0);
  });

  test.each([
    ['errorFields', wrap('this.logger.error("x", { ...errorFields(error) });')],
    ['describeError', wrap('this.logger.error("x", describeError(error));')],
    ['propriedade com o mesmo nome', wrap('this.logger.info("x", { error: 1, other: foo.error });')],
    ['sem catch', 'this.logger.info("x", { messageId: parsed.messageId });'],
    ['variável de catch fora do logger', wrap('this.metrics.increment("x", { reason: classify(error) });')],
    ['texto dentro de string', wrap('this.logger.info("error.message is not logged", {});')],
    ['texto dentro de comentário', wrap('this.logger.info("x", {}); // error.message')],
  ])('aceita %s', (_name, source) => {
    expect(findLoggerLeaks(source)).toEqual([]);
  });
});

describe('src/', () => {
  test('nenhum argumento de logger carrega .message, .stack ou variável de catch fora de errorFields/describeError', async () => {
    const found: string[] = [];
    let scanned = 0;
    let loggerCalls = 0;
    for await (const path of new Bun.Glob('src/**/*.ts').scan('.')) {
      scanned++;
      const source = await Bun.file(path).text();
      loggerCalls += [...mask(source).matchAll(LOGGER_CALL)].length;
      for (const leak of findLoggerLeaks(source)) found.push(`${path}:${leak.line} ${leak.reason}`);
    }
    // Sem isso, um glob ou regex quebrado passaria em vazio.
    expect(scanned).toBeGreaterThan(30);
    expect(loggerCalls).toBeGreaterThan(20);
    expect(found).toEqual([]);
  });
});
