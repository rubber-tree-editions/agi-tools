import fs from 'fs';
import osPath from 'path';
import { actionCommandsByName, testCommandsByName } from './commands';

const TRIGRAPHS = {
  "??=": "#",
  "??/": "\\",
  "??'": "^",
  "??(": "[",
  "??)": "]",
  "??!": "|",
  "??<": "{",
  "??>": "}",
  "??-": "~"
} as const;
type trigraph_t = keyof typeof TRIGRAPHS;

const tokenize = (src: string, path: string) => {
  // trigraphs
  src = src.replace(/\?\?[=\/'()!<>\-]/g, t => TRIGRAPHS[t as trigraph_t]);
  // line splicing
  src = src.replace(/\\(\r\n?|\n)/g, '');
  // split to lines
  const lines = src.split(/\r\n?|\n/g);
  // tokenization
  let inComment = false;
  const tokenLines = lines.map((line, i) => {
    const tokens = line.match(/[a-z_][a-z_0-9]*|\.?[0-9](?:[ep][\+\-]|[a-z0-9_\.])*|"(?:[^"\\]+|\\.)*"|'(?:[^'\\]+|\\.)*'|\+[\+=]|\-[\-=>]|<<=?|>>=?|<[%:]|[%:]>|%:(?=%:)?|\/[\*=\/]|\*[=\/]|[=!&|^<>]=|&&|\|\||::|\S/gi) || new Array<string>();
    for (let token_i = 0; token_i < tokens.length; token_i++) {
      if (inComment) {
        if (tokens[token_i] === '*/') {
          inComment = false;
        }
        tokens.splice(token_i, 1);
        token_i--;
      }
      else if (tokens[token_i] === '/*') {
        tokens.splice(token_i, 1);
        token_i--;
        inComment = true;
      }
      else if (tokens[token_i] === '*/') {
        tokens.splice(token_i, 1, '*', '/');
        token_i++;
      }
      else if (tokens[token_i] === '//') {
        tokens.splice(token_i);
        break;
      }
    }
    return {
      tokens,
      lineNumber: i+1,
      fileName: path,
    };
  });
  if (inComment) {
    throw new Error('unterminated comment');
  }
  return tokenLines;
};

class LineSyntaxError extends SyntaxError {
  constructor({ fileName, lineNumber }: { fileName: string, lineNumber: number }, message: string) {
    super(`[${fileName}]:${lineNumber}: ${message}`);
    this.fileName = fileName;
    this.lineNumber = lineNumber;
  }
  readonly fileName: string;
  readonly lineNumber: number;
}

const isStringLiteralToken = (s: string) => s[0] === '"';
const isKeywordToken = (s?: string | null) => /^[a-z_]/i.test(s || '');
const isCharLiteralToken = (s: string) => s[0] === "'";
const isNumberToken = (s?: string) => /^\.?[0-9]/.test(s || '');

const ESCAPES = {
  '\\a': '\x07',
  '\\b': '\x08',
  '\\e': '\x1B',
  '\\f': '\x0C',
  '\\n': '\x0A',
  '\\r': '\x0D',
  '\\t': '\x09',
  '\\v': '\x0B',
  '[': '\x0A',
} as const;
type escape_t = keyof typeof ESCAPES;

const decodeStringLiteral = (s: string) => s.slice(1, -1).replace(/\\.|\[/g, esc => ESCAPES[esc as escape_t] || esc.slice(1));
const decodeCharLiteral = (s: string) => s.slice(1, -1).replace(/\\.|\[/g, esc => ESCAPES[esc as escape_t] || esc.slice(1)).codePointAt(0) || 0;
const decodeIntegerLiteral = (s: string) => /^0[0-9]+$/.test(s || '') ? Number.parseInt(s, 8) : /^[0-9]+|^0x[0-9a-f]+$/i.test(s) ? Number.parseInt(s || '') : NaN;

interface CallExpression {
  type: 'call';
  func: string;
  params: Expression[];
}

interface AndExpression {
  type: 'and';
  operands: Expression[];
}

interface OrExpression {
  type: 'or';
  operands: Expression[];
}

interface NotExpression {
  type: 'not';
  operand: Expression;
}

interface LiteralExpression {
  type: 'literal';
  literal: string;
}

interface Uint8Expression {
  type: 'uint8';
  meaning: 'number' | 'variable' | 'flag' | 'variable-value' | 'controller' | 'inventory-item' | 'message' | 'room-object' | 'string';
  value: number;
}

interface Uint16Expression {
  type: 'uint16';
  meaning: 'word';
  value: number;
}

interface MathExpression {
  type: 'math';
  operator: '+' | '-' | '*' | '/';
  operands: [Expression, Expression];
}

type Expression = CallExpression | AndExpression | OrExpression | NotExpression | LiteralExpression | MathExpression | Uint8Expression | Uint16Expression;

interface CallStatement {
  type: 'call';
  func: string;
  params: Expression[];
}

interface LabelStatement {
  type: 'label';
  label: string;
}

interface GotoStatement {
  type: 'goto';
  label: string;
}

interface IfStatement {
  type: 'if';
  condition: Expression;
  thenDo: Statement;
  elseDo?: Statement;
}

interface WhileStatement {
  type: 'while';
  condition: Expression;
  doThis: Statement;
}

interface EmptyStatement {
  type: 'empty';
}

interface BlockStatement {
  type: 'block';
  body: Statement[];
}

interface DoStatement {
  type: 'do';
  body: Statement;
  condition: Expression;
}

type Statement = CallStatement | LabelStatement | IfStatement | WhileStatement | GotoStatement | EmptyStatement | BlockStatement | DoStatement;

const varTest = /^v(?:0|1[0-9]{0,2}|2(?:[0-4][0-9]|5[0-5]|[0-9])?|[3-9][0-9]?)$/;
const flagTest = /^f(?:0|1[0-9]{0,2}|2(?:[0-4][0-9]|5[0-5]|[0-9])?|[3-9][0-9]?)$/;
const anyValueTest = /^[vfmoiswc](?:0|1[0-9]{0,2}|2(?:[0-4][0-9]|5[0-5]|[0-9])?|[3-9][0-9]?)$/;
const intTest = /^0[0-7]*|0x[a-f0-9]+|[1-9][0-9]*$/i;

const UINT8TYPE_BY_PREFIX = {
  m: 'message',
  c: 'controller',
  v: 'variable',
  f: 'flag',
  i: 'inventory-item',
  o: 'room-object',
  s: 'string',
} as const;
type prefix_t = keyof typeof UINT8TYPE_BY_PREFIX;

export async function loadDictionary(path: string) {
  const raw = await fs.promises.readFile(path, {encoding:'utf-8'});
  const byCode = new Map<number, string[]>();
  const byWord = new Map<string, number>();
  for (const line of raw.split(/\r\n?|\n/g).filter(l => !/^\s*$|^\s*\*/.test(l))) {
    const match = line.match(/^\s*(\d+)\s+(\S.*?)\s*$/);
    if (!match) {
      throw new Error('unexpected content in dictionary: '+line);
    }
    const code = +match[1];
    const word = match[2];
    if (byWord.has(word)) {
      if (byWord.get(word) === code) {
        continue;
      }
      throw new Error('word cannot have multiple codes: ' + word);
    }
    if (byCode.has(code)) byCode.get(code)!.push(word);
    else byCode.set(code, [word]);
    byWord.set(word, code);
  }
  return { byWord, byCode };
}

export async function loadItems(path: string) {
  const raw = await fs.promises.readFile(path, {encoding:'utf-8'});
  const byCode = new Map<number, string[]>();
  const byName = new Map<string, number>();
  for (const line of raw.split(/\r\n?|\n/g).filter(l => !/^\s*$|^\s*\*/.test(l))) {
    const match = line.match(/^\s*(\d+)\s*:(.*?)$/);
    if (!match) {
      throw new Error('unexpected content in item file: '+line);
    }
    const code = +match[1];
    const word = match[2];
    if (!byName.has(word)) {
      byName.set(word, code);
    }
    if (byCode.has(code)) byCode.get(code)!.push(word);
    else byCode.set(code, [word]);
  }
  return { byName, byCode };
}

const booleanify = (expr: Expression): Expression => {
  switch (expr.type) {
    case 'and': case 'or': return {
      type: expr.type,
      operands: expr.operands.map(booleanify),
    };
    case 'not': return {
      type: 'not',
      operand: booleanify(expr.operand),
    };
    case 'uint8': {
      if (expr.meaning === 'flag') {
        return {
          type: 'call',
          func: 'isset',
          params: [expr],
        };
      }
      if (expr.meaning === 'variable') {
        return {
          type: 'call',
          func: 'issetv',
          params: [expr],
        };
      }
      // fall through:
    }
    default: {
      return expr;
    }
  }
};

class PushbackIterator<T> implements Iterator<T> {
  constructor(wrap: Iterable<T>) {
    this.wrap = wrap[Symbol.iterator]();
  }
  private wrap: Iterator<T>;
  pushback = new Array<T>();
  next() {
    if (this.pushback.length !== 0) {
      return {done:false, value:this.pushback.shift()!};
    }
    return this.wrap.next();
  }
}

const OP_PRECEDENCE = new Map([
  ['||', 0],
  ['&&', 1],
  ['|', 2],
  ['^', 3],
  ['&', 4],
  ['==', 5], ['!=', 5],
  ['<', 6], ['<=', 6], ['>', 6], ['>=', 6],
  ['<<', 7], ['>>', 7],
  ['+', 8], ['-', 8],
  ['*', 9], ['/', 9], ['%', 9],
]);

export default async function compile({ path, simpleMacros = new Map() }: { path: string, simpleMacros: Map<string, string[]> }) {
  const src = await fs.promises.readFile(path, {encoding:'utf-8'});
  const tokenLines = tokenize(src, path);
  // directive handling
  let ifStack = new Array<{ifLine:{lineNumber: number, fileName: string}, elseLine?:{lineNumber: number, fileName: string}}>();
  const messageNumbers = new Map<string, number>([['', 0]]);
  const messages = [''];
  let nextFreeMessageNumber = 1;
  const itemNumbers = new Map<string, number>();
  const wordNumbers = new Map<string, number>();
  const parseDirectiveExpression = (line: { fileName: string, lineNumber: number }, tokens: Iterable<string>): number => {
    const tokenReader = new PushbackIterator(tokens);
    function readAtom(): number {
      let step = tokenReader.next();
      while (!step.done && isKeywordToken(step.value) && simpleMacros.has(step.value)) {
        tokenReader.pushback.unshift(...simpleMacros.get(step.value)!);
        step = tokenReader.next();
      }
      if (step.done) {
        throw new LineSyntaxError(line, 'unexpected end of expression');
      }
      switch (step.value) {
        case '(': {
          const expr = readExpression();
          step = tokenReader.next();
          if (step.done) {
            throw new LineSyntaxError(line, 'unexpected end of expression');
          }
          if (step.value !== ')') {
            throw new LineSyntaxError(line, 'unexpected content');
          }
          return expr;
        }
        case '!': {
          return readAtom() ? 0 : 1;
        }
        case '+': {
          return +readAtom();
        }
        case '-': {
          return -readAtom();
        }
        case '~': {
          return ~readAtom();
        }
      }
      if (isKeywordToken(step.value)) {
        if (step.value === 'defined') {
          step = tokenReader.next();
          if (!step.done) {
            if (step.value === '(') {
              step = tokenReader.next();
              if (step.done || !isKeywordToken(step.value)) {
                throw new LineSyntaxError(line, "invalid content in defined()");
              }
              const isDefined = simpleMacros.has(step.value);
              step = tokenReader.next();
              if (step.done || step.value !== ')') {
                throw new LineSyntaxError(line, "invalid content in defined()");
              }
              return isDefined ? 1 : 0;
            }
            else {
              tokenReader.pushback.unshift(step.value);
            }
          }
        }
        return 0;
      }
      if (isNumberToken(step.value)) {
        return +step.value | 0;
      }
      if (isCharLiteralToken(step.value)) {
        return decodeCharLiteral(step.value);
      }
      throw new LineSyntaxError(line, "unexpected content in expression");
    }
    function extendExpression(expr: number, level = 0): number {
      let step = tokenReader.next();
      while (!step.done) {
        const precedence = OP_PRECEDENCE.get(step.value);
        if (typeof precedence !== 'number' || precedence < level) {
          tokenReader.pushback.unshift(step.value);
          break;
        }
        switch (step.value) {
          case '==': {
            expr = (expr === readExpression(precedence + 1)) ? 1 : 0;
            break;
          }
          case '!=': {
            expr = (expr !== readExpression(precedence + 1)) ? 1 : 0;
            break;
          }
          case '>': {
            expr = (expr > readExpression(precedence + 1)) ? 1 : 0;
            break;
          }
          case '>=': {
            expr = (expr >= readExpression(precedence + 1)) ? 1 : 0;
            break;
          }
          case '<': {
            expr = (expr < readExpression(precedence + 1)) ? 1 : 0;
            break;
          }
          case '<=': {
            expr = (expr <= readExpression(precedence + 1)) ? 1 : 0;
            break;
          }
          case '+': {
            expr = (expr + readExpression(precedence + 1)) | 0;
            break;
          }
          case '-': {
            expr = (expr - readExpression(precedence + 1)) | 0;
            break;
          }
          case '*': {
            expr = Math.imul(expr, readExpression(precedence + 1));
            break;
          }
          case '/': {
            expr = (expr / readExpression(precedence + 1)) | 0;
            break;
          }
          case '%': {
            expr = (expr % readExpression(precedence + 1)) | 0;
            break;
          }
          case '^': {
            expr ^= readExpression(precedence + 1);
            break;
          }
          case '<<': {
            expr <<= readExpression(precedence + 1);
            break;
          }
          case '>>': {
            expr >>= readExpression(precedence + 1);
            break;
          }
          case '&': {
            expr &= readExpression(precedence + 1);
            break;
          }
          case '|': {
            expr |= readExpression(precedence + 1);
            break;
          }
          case '&&': {
            const rhs = readExpression(precedence+1);
            if (expr) {
              expr = rhs;
            }
            break;
          }
          case '||': {
            const rhs = readExpression(precedence+1);
            if (!expr) {
              expr = rhs;
            }
            break;
          }
        }
        step = tokenReader.next();
      }
      return expr;
    }
    function readExpression(level = 0): number {
      return extendExpression(readAtom(), level);
    }
    const expr = readExpression();
    if (!tokenReader.next().done) {
      throw new LineSyntaxError(line, 'unexpected content in expression');
    }
    return expr;
  };
  for (let line_i = 0; line_i < tokenLines.length; line_i++) {
    const line = tokenLines[line_i];
    if (line.tokens[0] === '#') {
      // directive
      switch (line.tokens[1]) {
        case 'include': {
          if (line.tokens.length !== 3 || !isStringLiteralToken(line.tokens[2])) {
            throw new LineSyntaxError(line, 'invalid #include directive');
          }
          const includePath = osPath.resolve(path, '../' + decodeStringLiteral(line.tokens[2]));
          const includedSrc = await fs.promises.readFile(includePath, {encoding:'utf-8'});
          const includedTokens = tokenize(includedSrc, includePath);
          tokenLines.splice(line_i, 1, ...includedTokens);
          line_i--;
          break;
        }
        case 'define': {
          if (line.tokens.length < 3 || !isKeywordToken(line.tokens[2])) {
            throw new LineSyntaxError(line, 'invalid #define directive');
          }
          if (simpleMacros.has(line.tokens[2])) {
            throw new LineSyntaxError(line, 'attempt to redefine existing macro: ' + line.tokens[2]);
          }
          simpleMacros.set(line.tokens[2], line.tokens.slice(3));
          line.tokens.length = 0;
          break;
        }
        case 'undef': {
          if (line.tokens.length !== 3 || !isKeywordToken(line.tokens[2])) {
            throw new LineSyntaxError(line, 'invalid #undef directive');
          }
          if  (!simpleMacros.has(line.tokens[2])) {
            throw new LineSyntaxError(line, 'attempt to undefine nonexisting macro: ' + line.tokens[2]);
          }
          simpleMacros.delete(line.tokens[2]);
          line.tokens.length = 0;
          break;
        }
        case 'ifdef': case 'ifndef': case 'if': {
          let conditionalTokens = line.tokens.splice(2);
          if (line.tokens[1] === 'if' ? conditionalTokens.length === 0 : conditionalTokens.length !== 1 || !isKeywordToken(conditionalTokens[0])) {
            throw new LineSyntaxError(line, `invalid #${line.tokens[1]} directive`);
          }
          if (line.tokens[1] === 'ifdef') {
            conditionalTokens = ['defined', '(', conditionalTokens[0], ')'];
          }
          else if (line.tokens[1] === 'ifndef') {
            conditionalTokens = ['!', 'defined', '(', conditionalTokens[0], ')'];
          }
          const conditional = parseDirectiveExpression(line, conditionalTokens);
          ifStack.push({ifLine:line});
          if (!conditional) {
            const stackBase = ifStack.length;
            clearLines: for (;;) {
              if (++line_i === tokenLines.length) {
                throw new LineSyntaxError(line, `unmatched #${line.tokens[1]} directive`);
              }
              const removeTokens = tokenLines[line_i].tokens.splice(0);
              if (removeTokens[0] === '#') {
                switch (removeTokens[1]) {
                  case 'else': {
                    if (ifStack[ifStack.length-1].elseLine) {
                      throw new LineSyntaxError(tokenLines[line_i], 'unmatched #else directive');
                    }
                    ifStack[ifStack.length-1].elseLine = tokenLines[line_i];
                    if (ifStack.length === stackBase) {
                      break clearLines;
                    }
                    continue clearLines;
                  }
                  case 'elif': {
                    if (ifStack[ifStack.length-1].elseLine) {
                      throw new LineSyntaxError(tokenLines[line_i], 'unmatched #elif directive');
                    }
                    ifStack[ifStack.length-1] = {ifLine:tokenLines[line_i]};
                    if (ifStack.length === stackBase) {
                      const exprTokens = removeTokens.slice(2);
                      if (parseDirectiveExpression(tokenLines[line_i], exprTokens)) {
                        break clearLines;
                      }
                    }
                    continue clearLines;
                  }
                  case 'endif': {
                    if (removeTokens.length !== 2) {
                      throw new LineSyntaxError(tokenLines[line_i], 'invalid #endif directive');
                    }
                    ifStack.pop();
                    if (ifStack.length < stackBase) {
                      break clearLines;
                    }
                    continue clearLines;
                  }
                  case 'if': case 'ifdef': case 'ifndef': {
                    ifStack.push({ifLine:tokenLines[line_i]});
                    continue clearLines;
                  }
                }
              }
            }
          }
          line.tokens.length = 0;
          break;
        }
        case 'else': case 'elif': {
          if (line.tokens[1] === 'else' ? line.tokens.length !== 2 : line.tokens.length < 3) {
            throw new LineSyntaxError(line, `invalid #${line.tokens[1]} directive`);
          }
          if (ifStack.length === 0 || ifStack[ifStack.length-1].elseLine) {
            throw new LineSyntaxError(line, `unmatched #${line.tokens[1]} directive`);
          }
          if (line.tokens[1] === 'elif') {
            ifStack[ifStack.length-1] = {ifLine:line};
          }
          else {
            ifStack[ifStack.length-1].elseLine = line;
          }
          line.tokens.length = 0;
          const stackBase = ifStack.length;
          clearLines: for (;;) {
            if (++line_i === tokenLines.length) {
              throw new LineSyntaxError(line, `unmatched #${line.tokens[1]} directive`);
            }
            const removeTokens = tokenLines[line_i].tokens.splice(0);
            if (removeTokens[0] === '#') {
              switch (removeTokens[1]) {
                case 'else': case 'elif': {
                  if (ifStack[ifStack.length-1].elseLine) {
                    throw new LineSyntaxError(tokenLines[line_i], `unmatched #${removeTokens[1]} directive`);
                  }
                  if (removeTokens[1] === 'else') {
                    ifStack[ifStack.length-1].elseLine = tokenLines[line_i];
                  }
                  else {
                    ifStack[ifStack.length-1] = {ifLine:tokenLines[line_i]};
                  }
                  continue clearLines;
                }
                case 'endif': {
                  if (removeTokens.length !== 2) {
                    throw new LineSyntaxError(tokenLines[line_i], 'invalid #endif directive');
                  }
                  ifStack.pop();
                  if (ifStack.length < stackBase) {
                    break clearLines;
                  }
                  continue clearLines;
                }
                case 'if': case 'ifdef': case 'ifndef': {
                  ifStack.push({ifLine:tokenLines[line_i]});
                  continue clearLines;
                }
              }
            }
          }
          break;
        }
        case 'endif': {
          if (line.tokens.length !== 2) {
            throw new LineSyntaxError(line, 'invalid #endif directive');
          }
          if (ifStack.length === 0) {
            throw new LineSyntaxError(line, 'unmatched #endif directive');
          }
          ifStack.pop();
          line.tokens.length = 0;
          break;
        }
        case 'message': {
          const messageNumber = decodeIntegerLiteral(line.tokens[2]);
          if (line.tokens.length !== 4 || Number.isNaN(messageNumber) || !isStringLiteralToken(line.tokens[3])) {
            throw new LineSyntaxError(line, 'invalid #message directive');
          }
          const message = decodeStringLiteral(line.tokens[3]);
          // if a message is explicitly repeated, use the first one by default for literal substitutions
          if (!messageNumbers.has(message)) {
            messageNumbers.set(message, messageNumber);
          }
          messages.length = Math.max(messages.length, messageNumber+1);
          messages[messageNumber] = message;
          line.tokens.length = 0;
          break;
        }
        case 'word': {
          const wordNumber = decodeIntegerLiteral(line.tokens[2]);
          for (let token_i = 3; token_i < line.tokens.length; token_i += 2) {
            if (isStringLiteralToken(line.tokens[token_i])) {
              wordNumbers.set(decodeStringLiteral(line.tokens[token_i]), wordNumber);
            }
            else if (isKeywordToken(line.tokens[token_i]) || isNumberToken(line.tokens[token_i])) {
              wordNumbers.set(line.tokens[token_i], wordNumber);
            }
            else {
              throw new LineSyntaxError(line, "invalid #word directive");
            }
            if ((token_i+1) < line.tokens.length && line.tokens[token_i+1] !== ',') {
              throw new LineSyntaxError(line, "invalid #word directive");
            }
          }
          line.tokens.length = 0;
          break;
        }
        case 'item': {
          if (line.tokens.length !== 4) {
            throw new LineSyntaxError(line, "invalid #item directive");
          }
          const itemNumber = decodeIntegerLiteral(line.tokens[2]);
          if (isStringLiteralToken(line.tokens[3])) {
            itemNumbers.set(decodeStringLiteral(line.tokens[3]), itemNumber);
          }
          else if (isKeywordToken(line.tokens[3]) || isNumberToken(line.tokens[3])) {
            itemNumbers.set(line.tokens[3], itemNumber);
          }
          line.tokens.length = 0;
          break;
        }
        default: {
          throw new LineSyntaxError(line, isKeywordToken(line.tokens[1]) ? `unknown/unsupported directive: #${line.tokens[1]}` : 'invalid directive');
        }
      }
      continue;
    }
    else {
      for (let i = 0; i < line.tokens.length; i++) {
        if (simpleMacros.has(line.tokens[i])) {
          line.tokens.splice(i, 1, ...simpleMacros.get(line.tokens[i])!);
          i--;
          continue;
        }
      }
    }
  }
  if (ifStack.length !== 0) {
    throw new LineSyntaxError(ifStack[0].ifLine, 'unmatched #if');
  }
  let repeatToken = false;
  function *readTokens() {
    for (const line of tokenLines) {
      for (const token of line.tokens) {
        yield {token, line};
        while (repeatToken) {
          repeatToken = false;
          yield {token, line};
        }
      }
    }
  }
  const t = readTokens();
  const tryToken = (req?: string | RegExp | ((str: string) => boolean)) => {
    const step = t.next();
    if (step.done) {
      return false;
    }
    if (typeof req === 'string') {
      if (step.value.token !== req) {
        repeatToken = true;
        return false;
      }
    }
    else if (typeof req === 'function') {
      if (!req(step.value.token)) {
        repeatToken = true;
        return false;
      }
    }
    else if (req) {
      if (!req.test(step.value.token)) {
        repeatToken = true;
        return false;
      }
    }
    return step.value;
  };
  const requireToken = (req?: string | RegExp | ((str: string) => boolean)) => {
    const step = t.next();
    if (step.done) {
      throw new SyntaxError('unexpected end of input');
    }
    if (typeof req === 'string') {
      if (step.value.token !== req) {
        throw new LineSyntaxError(step.value.line, 'expected '+req+', got '+step.value.token);
      }
    }
    else if (typeof req === 'function') {
      if (!req(step.value.token)) {
        throw new LineSyntaxError(step.value.line, 'unexpected token: '+step.value.token);
      }
    }
    else if (req) {
      if (!req.test(step.value.token)) {
        throw new LineSyntaxError(step.value.line, 'unexpected token: '+step.value.token);
      }
    }
    return step.value;
  };
  function readStatement(): Statement {
    const { token, line } = requireToken();
    switch (token) {
      case 'if': {
        requireToken('(');
        const condition = booleanify(readExpression());
        requireToken(')');
        const thenDo = readStatement();
        return tryToken('else') ? {type:'if', condition, thenDo, elseDo:readStatement()} : {type:'if', condition, thenDo};
      }
      case 'while': {
        requireToken('(');
        const condition = booleanify(readExpression());
        requireToken(')');
        const doThis = readStatement();
        return {type:'while', condition, doThis};
      }
      case 'do': {
        const body = readStatement();
        requireToken('while');
        requireToken('(');
        const condition = booleanify(readExpression());
        requireToken(')');
        requireToken(';');
        return {type:'do', body, condition};
      }
      case 'return': {
        if (tryToken('(')) {
          requireToken(')');
        }
        requireToken(';');
        return {type:'call', func:'return', params:[]};
      }
      case 'goto': {
        let label: string;
        let unparenthesized = !tryToken('(');
        label = requireToken(isKeywordToken).token;
        while (tryToken('.')) {
          label += '.' + requireToken(isKeywordToken).token;
        }
        if (!unparenthesized) {
          requireToken(')');
        }
        requireToken(';');
        return {
          type: 'goto',
          label,
        };
      }
      case '{': {
        const body = new Array<Statement>();
        while (!tryToken('}')) {
          body.push(readStatement());
        }
        return {type:'block', body};
      }
      case ';': {
        return {type:'empty'};
      }
      case '*': {
        const { token: varRef } = requireToken(varTest);
        requireToken('=');
        const rhs = readExpression();
        requireToken(';');
        if (rhs.type === 'uint8') {
          if (rhs.meaning === 'variable') {
            return {
              type: 'call',
              func: 'lindirectv',
              params: [{type:'uint8', meaning:'variable', value:Number.parseInt(varRef.slice(1))}, rhs],
            };
          }
          else if (rhs.meaning === 'number') {
            return {
              type: 'call',
              func: 'lindirectn',
              params: [{type:'uint8', meaning:'variable', value:Number.parseInt(varRef.slice(1))}, rhs],
            };
          }
        }
        throw new LineSyntaxError(requireToken().line, 'invalid indirect variable assignment: value must be a number literal or another variable');
      }
    }
    if (varTest.test(token)) {
      const varRef: Uint8Expression = {type:'uint8', meaning:'variable', value:+token.slice(1)};
      const crementToken = tryToken(/^\+\+|\-\-$/);
      if (crementToken) {
        requireToken(';');
        return {
          type: 'call',
          func: crementToken.token === '++' ? 'increment' : 'decrement',
          params: [varRef],
        };
      }
      const assignToken = tryToken(/^[\+\-*\/]?=$/);
      if (assignToken) {
        const rhs = readExpression();
        requireToken(';');
        if (rhs.type === 'uint8') {
          if (assignToken.token === '=') {
            if (rhs.meaning === 'number') {
              return {
                type: 'call',
                func: 'assignn',
                params: [varRef, rhs],
              };
            }
            else if (rhs.meaning === 'variable') {
              return {
                type: 'call',
                func: 'assignv',
                params: [varRef, rhs],
              };
            }
            else if (rhs.meaning === 'variable-value') {
              return {
                type: 'call',
                func: 'rindirect',
                params: [varRef, {type:'uint8', meaning:'variable', value:rhs.value}],
              };
            }
          }
          else {
            const funcBase = ({ '+=': 'add', '-=': 'sub', '*=': 'mul.', '/=': 'div.' })[assignToken.token]!;
            if (rhs.meaning === 'number') {
              return {
                type: 'call',
                func: funcBase+'n',
                params: [varRef, rhs],
              };
            }
            else if (rhs.meaning === 'variable') {
              return {
                type: 'call',
                func: funcBase+'v',
                params: [varRef, rhs],
              };
            }
          }
        }
        throw new LineSyntaxError(assignToken.line, 'invalid assignment');
      }
      throw new LineSyntaxError(requireToken().line, 'unexpected content');
    }
    if (!isKeywordToken(token)) {
      throw new LineSyntaxError(line, 'unexpected content');
    }
    let func = token;
    while (tryToken('.')) {
      func += '.' + requireToken(isKeywordToken).token;
    }
    if (tryToken(':')) {
      return {
        type: 'label',
        label: func,
      };
    }
    requireToken('(');
    let params = new Array<Expression>();
    if (!tryToken(')')) {
      params.push(readExpression());
      while (tryToken(',')) {
        params.push(readExpression());
      }
      requireToken(')');
    }
    requireToken(';');
    if (!actionCommandsByName.has(func)) {
      throw new LineSyntaxError(line, `unknown function: ${func}()`);
    }
    const commandParams = actionCommandsByName.get(func)!.params || [];
    if (commandParams !== 'vararg') {
      if (params.length !== commandParams.length) {
        throw new LineSyntaxError(line, `wrong number of parameters for ${func}() - expected ${commandParams.length}, got ${params.length}`);
      }
      for (let param_i = 0; param_i < commandParams.length; param_i++) {
        const param = params[param_i];
        if (param.type === 'literal') {
          if (!isStringLiteralToken(param.literal)) {
            throw new LineSyntaxError(line, `parameter ${param_i+1} for ${func}() -- expected ${commandParams[param_i]}, got ${param.literal}`);
          }
          const strLiteral = decodeStringLiteral(param.literal);
          if (commandParams[param_i] === 'message') {
            if (messageNumbers.has(strLiteral)) {
              params[param_i] = {
                type: 'uint8',
                meaning: 'message',
                value: messageNumbers.get(strLiteral)!,
              };
            }
            else {
              while (typeof messages[nextFreeMessageNumber] === 'string') {
                nextFreeMessageNumber++;
              }
              params[param_i] = {
                type: 'uint8',
                meaning: 'message',
                value: nextFreeMessageNumber,
              };
              messageNumbers.set(strLiteral, nextFreeMessageNumber);
              messages[nextFreeMessageNumber++] = strLiteral;
            }
          }
          else if (commandParams[param_i] === 'word') {
            if (!wordNumbers.has(strLiteral)) {
              throw new LineSyntaxError(line, `word not found in dictionary: ` + strLiteral);
            }
            params[param_i] = {
              type: 'uint16',
              meaning: 'word',
              value: wordNumbers.get(strLiteral)!,
            };
          }
          else if (commandParams[param_i] === 'inventory-item') {
            if (!itemNumbers.has(strLiteral)) {
              throw new LineSyntaxError(line, `unknown inventory item: ${strLiteral}`);
            }
            params[param_i] = {
              type: 'uint8',
              meaning: 'inventory-item',
              value: itemNumbers.get(strLiteral)!,
            };
          }
          else {
            throw new LineSyntaxError(line, `parameter ${param_i+1} for ${func}() -- expected ${commandParams[param_i]}, got ${param.literal}`);
          }
        }
      }
    }
    return {
      type: 'call',
      func,
      params,
    };
  }
  const SWAP_COMPARATOR = {
    '<': '>',
    '<=': '>=',
    '>': '<',
    '>=': '<=',
    '==': '==',
    '!=': '!=',
  } as const;
  const NEGATE_COMPARATOR = {
    '<': '>=',
    '<=': '>',
    '>': '<=',
    '>=': '<',
    '==': '!=',
    '!=': '==',
  } as const;
  function extendExpression(baseExpression: Expression, level: number): Expression {
    let op = tryToken(/^[\+\-\*\/]|[<>]=?|[!=]=|\|\||&&$/);
    if (!op) {
      return baseExpression;
    }
    let expression = baseExpression;
    do {
      const precedence = OP_PRECEDENCE.get(op.token)!;
      if (precedence < level) {
        break;
      }
      switch (op.token) {
        case '||': case '&&': {
          const operands = new Array<Expression>(expression, readExpression(precedence+1));
          while (tryToken(op.token)) {
            operands.push(readExpression(precedence+1));
          }
          expression = {
            type: op.token === '||' ? 'or' : 'and',
            operands,
          };
          break;
        }
        case '==': case '!=': case '<': case '<=': case '>': case '>=': {
          let comparator = op.token;
          let left = expression;
          let right = readExpression(precedence+1);
          if (left.type === 'uint8' && left.meaning === 'number') {
            [left, right] = [right, left];
            comparator = SWAP_COMPARATOR[comparator];
          }
          if (left.type !== 'uint8' || left.meaning !== 'variable' || right.type !== 'uint8' || !(right.meaning === 'variable' || right.meaning === 'number')) {
            throw new LineSyntaxError(op.line, 'invalid comparator: can only compare variables to an integer literal or another variable');
          }
          let negate = comparator == '!=' || comparator == '<=' || comparator == '>=';
          if (negate) {
            comparator = NEGATE_COMPARATOR[comparator];
          }
          const comparison: Expression = {
            type: 'call',
            func: ({ '==': 'equal', '>': 'greater', '<': 'less' })[comparator as '==' | '<' | '>'] + (right.meaning==='variable'?'v':'n'),
            params: [left, right],
          };
          expression = negate ? { type: 'not', operand: comparison } : comparison;
          break;
        }
        case '+': case '-': case '*': case '/': {
          expression = {
            type: 'math',
            operator: op.token,
            operands: [expression, readExpression(precedence+1)],
          };
          break;
        }
        default: {
          throw new SyntaxError('unexpected operator: ' + op.token);
        }
      }
      op = tryToken(/^[\+\-\*\/]|[<>]=?|[!=]=|\|\||&&$/);
    } while (op);
    repeatToken = true;
    return expression;
  }
  function readAtomExpression(): Expression {
    const { token, line } = requireToken();
    if (isKeywordToken(token)) {
      if (anyValueTest.test(token)) {
        if (token.startsWith('w')) {
          return {
            type: 'uint16',
            meaning: 'word',
            value: Number.parseInt(token.slice(1)),
          };
        }
        else {
          return {
            type: 'uint8',
            meaning: UINT8TYPE_BY_PREFIX[token[0] as prefix_t],
            value: Number.parseInt(token.slice(1)),
          };            
        }
      }
      let func = token;
      if (tryToken('.')) {
        do {
          func += '.' + requireToken(isKeywordToken).token;
        } while (tryToken('.'));
      }
      if (!tryToken('(')) {
        if (testCommandsByName.has(func)) {
          throw new LineSyntaxError(line, 'invalid use of function ' + func + '()');
        }
        throw new LineSyntaxError(line, 'unknown value: ' + func);
      }
      let params = new Array<Expression>();
      if (!tryToken(')')) {
        do {
          params.push(readExpression());
        } while (tryToken(','));
        requireToken(')');
      }
      if (!testCommandsByName.has(func)) {
        if (func === '__OR__') {
          return {
            type: 'or',
            operands: params,
          };
        }
        throw new LineSyntaxError(line, 'unknown function: '+func);
      }
      const testCommand = testCommandsByName.get(func)!;
      if (testCommand.params === 'vararg') {
        params = params.map(v => {
          if (v.type === 'literal' && isStringLiteralToken(v.literal)) {
            const word = decodeStringLiteral(v.literal);
            if (!wordNumbers.has(word)) {
              throw new LineSyntaxError(line, 'word not found in dictionary: ' + word);
            }
            return {type:'uint16', meaning:'word', value:wordNumbers.get(word)!};
          }
          if (v.type === 'uint16' && v.meaning === 'word') {
            return v;
          }
          throw new LineSyntaxError(line, 'parameters must be words');
        });
      }
      else {
        const testParams = testCommand.params || [];
        if (params.length !== testParams.length) {
          throw new LineSyntaxError(line, `wrong number of parameters to ${func}(): expected ${testParams.length}, got ${params.length}`);
        }
        for (let i = 0; i < params.length; i++) {
          const p = params[i];
          if (p.type !== 'uint8' || p.meaning !== testParams[i]) {
            throw new LineSyntaxError(line, `invalid parameter ${i+1} to ${func}(): expected ${testParams[i]}, got ${p.type === 'uint8' ? p.meaning : p.type}`);
          }
        }
      }
      return {
        type: 'call',
        func,
        params,
      };
    }
    else if (intTest.test(token)) {
      return {
        type: 'uint8',
        meaning: 'number',
        value: decodeIntegerLiteral(token),
      };
    }
    else if (token === '!') {
      return {
        type: 'not',
        operand: readAtomExpression(),
      };
    }
    else if (token === '+') {
      return readAtomExpression();
    }
    else if (token === '-') {
      throw new LineSyntaxError(line, 'negative values are not supported');
    }
    else if (token === '*') {
      const indirect = readAtomExpression();
      if (indirect.type !== 'uint8' || indirect.meaning !== 'variable') {
        throw new LineSyntaxError(line, 'invalid indirect value access');
      }
      return {
        type: 'uint8',
        meaning: 'variable-value',
        value: indirect.value,
      };
    }
    else if (token === '(') {
      const expression = readExpression();
      requireToken(')');
      return expression;
    }
    else if (isStringLiteralToken(token)) {
      let stringLiteral = token;
      let append = tryToken(isStringLiteralToken);
      while (append) {
        stringLiteral = stringLiteral.slice(0, -1) + append.token.slice(1);
        append = tryToken(isStringLiteralToken);
      }
      return {
        type: 'literal',
        literal: stringLiteral,
      };
    }
    else {
      throw new LineSyntaxError(line, 'unexpected content');
    }
  }
  function readExpression(level = 0): Expression {
    let expression = readAtomExpression();
    expression = extendExpression(expression, level);
    return expression;
  }
  const statements = new Array<Statement>();
  while (tryToken()) {
    repeatToken = true;
    statements.push(readStatement());
  }
  const lastStatement = statements[statements.length-1];
  if (!(lastStatement && lastStatement.type === 'call' && lastStatement.func === 'return')) {
    statements.push({type:'call', func:'return', params:[]});
  }
  const labelPos = new Map<string, number>();
  const labelPromises = new Map<string, Promise<number>>();
  const labelListeners = new Map<string, (n: number) => void>();
  const buf = new Array<number>();
  const complete = new Array<Promise<void>>();
  const negateCondition = (expr: Expression, context?: 'and' | 'or'): Expression => {
    switch (expr.type) {
      case 'and': {
        return {
          type: 'or',
          operands: expr.operands.map(v => negateCondition(v, 'or')),
        };
      }
      case 'or': {
        return {
          type: 'and',
          operands: expr.operands.map(v => negateCondition(v, 'and')),
        };
      }
      case 'not': {
        return expr.operand;
      }
      default: {
        return {
          type: 'not',
          operand: expr,
        };
      }
    }
  };
  const pushCondition2 = (expr: Expression, ctx: 'and' | 'or' | 'not') => {
    switch (expr.type) {
      case 'and': {
        if (ctx !== 'and') {
          buf.push(0xFF);
        }
        for (const subcondition of expr.operands) {
          pushCondition2(subcondition, 'and');
        }
        if (ctx !== 'and') {
          buf.push(0xFF);
        }
        break;
      }
      case 'or': {
        if (ctx !== 'or') {
          buf.push(0xFC);
        }
        for (const subcondition of expr.operands) {
          pushCondition2(subcondition, 'or');
        }
        if (ctx !== 'or') {
          buf.push(0xFC);
        }
        break;
      }
      case 'not': {
        buf.push(0xFD);
        pushCondition2(expr.operand, 'not');
        break;
      }
      case 'call': {
        const cmd = testCommandsByName.get(expr.func);
        if (!cmd) {
          throw new Error('unknown test command: ' + expr.func);
        }
        buf.push(cmd.code);
        const params = expr.params;
        if (cmd.params === 'vararg') {
          if (expr.params.length > 255) {
            throw new Error('too many arguments to '+cmd.name+'()');
          }
          buf.push(expr.params.length);
        }
        for (const param of params) {
          switch (param.type) {
            case 'uint8': {
              buf.push(param.value);
              break;
            }
            case 'uint16': {
              buf.push(param.value & 0xff);
              buf.push((param.value >> 8) & 0xff);
              break;
            }
          }
        }
        break;
      }
      default: {
        throw new Error('unexpected condition type: ' + expr.type);
      }
    }
  };
  const pushCondition = (expr: Expression) => {
    buf.push(0xff);
    pushCondition2(expr, 'and');
    buf.push(0xff);
  };
  const pushStatement = (statement: Statement) => {
    switch (statement.type) {
      case 'block': {
        for (const bodyStatement of statement.body) {
          pushStatement(bodyStatement);
        }
        break;
      }
      case 'empty': {
        break;
      }
      case 'goto': {
        const basePos = buf.length + 3;
        if (labelPos.has(statement.label)) {
          const relPos = labelPos.get(statement.label)! - basePos;
          buf.push(0xfe, relPos & 0xff, (relPos >> 8) & 0xff);
        }
        else {
          let promise = labelPromises.get(statement.label);
          if (!promise) {
            promise = new Promise((resolve, reject) => {
              labelListeners.set(statement.label, (number) => {
                labelPromises.delete(statement.label);
                resolve(number);
              });
            });
            labelPromises.set(statement.label, promise);
          }
          complete.push(promise.then(n => {
            const relPos = n - basePos;
            buf[basePos-2] = relPos & 0xff;
            buf[basePos-1] = (relPos >> 8) & 0xff;
          }));
          buf.push(0xfe, 0, 0);
        }
        break;
      }
      case 'label': {
        if (labelPos.has(statement.label)) {
          throw new Error('multiple jump labels named '+statement.label);
        }
        labelPos.set(statement.label, buf.length);
        const listener = labelListeners.get(statement.label);
        if (listener) {
          listener(buf.length);
          labelListeners.delete(statement.label);
        }
        break;
      }
      case 'call': {
        const cmd = actionCommandsByName.get(statement.func);
        if (!cmd) {
          throw new Error('unknown command: '+statement.func);
        }
        buf.push(cmd.code);
        for (const param of statement.params) {
          switch (param.type) {
            case 'uint8': {
              buf.push(param.value);
              break;
            }
            case 'uint16': {
              buf.push(param.value & 0xff);
              buf.push((param.value >> 16) & 0xff);
              break;
            }
            default: {
              throw new Error('unexpected param type: '+param.type);
            }
          }
        }
        break;
      }
      case 'if': {
        pushCondition(statement.condition);
        buf.push(0, 0);
        const jumpFrom1 = buf.length;
        pushStatement(statement.thenDo);
        if (statement.elseDo) {
          buf.push(0xFE, 0, 0);
          const jumpFrom2 = buf.length;
          const relJump = buf.length - jumpFrom1;
          buf[jumpFrom1-2] = relJump & 0xff;
          buf[jumpFrom1-1] = (relJump >> 8) & 0xff;  
          pushStatement(statement.elseDo);
          const relJump2 = buf.length - jumpFrom2;
          buf[jumpFrom2-2] = relJump2 & 0xff;
          buf[jumpFrom2-1] = (relJump2 >> 8) & 0xff;
        }
        else {
          const relJump = buf.length - jumpFrom1;
          buf[jumpFrom1-2] = relJump & 0xff;
          buf[jumpFrom1-1] = (relJump >> 8) & 0xff;
        }
        break;
      }
      case 'while': {
        const backJumpTo = buf.length;
        pushCondition(statement.condition);
        buf.push(0, 0);
        const forewardJumpFrom = buf.length;
        pushStatement(statement.doThis);
        const relBackJump = backJumpTo - (buf.length + 3);
        buf.push(0xfe, relBackJump & 0xff, (relBackJump >> 8) & 0xff);
        const relJump2 = buf.length - forewardJumpFrom;
        buf[forewardJumpFrom-2] = relJump2 & 0xff;
        buf[forewardJumpFrom-1] = (relJump2 >> 8) & 0xff;
        break;
      }
      case 'do': {
        const backJumpPos = buf.length;
        pushStatement(statement.body);
        pushCondition(statement.condition);
        buf.push(0x03, 0x00);
        const relBackJump = backJumpPos - (buf.length + 3);
        buf.push(0xfe, relBackJump & 0xff, (relBackJump >> 8) & 0xff);
        break;
      }
    }
  };
  for (const statement of statements) {
    pushStatement(statement);
  }
  const undefinedLabels = [...labelListeners.keys()];
  if (undefinedLabels.length !== 0) {
    throw new Error('label target(s) not found: ' + undefinedLabels.join(', '));
  }
  await Promise.all(complete);
  let messageBlockLen = 0;
  const messageOffsets = new Array<number>();
  for (let message of messages) {
    if (message == null) {
      messageOffsets.push(-1);
    }
    else {
      messageOffsets.push(messageBlockLen);
      messageBlockLen += message.length + 1;
    }
  }
  return {
    bytecode: Buffer.from(buf),
    messageOffsets,
    messageBlock: Buffer.from(messages.filter(v => v != null).join('\0') + '\0', 'binary'),
  };
}
