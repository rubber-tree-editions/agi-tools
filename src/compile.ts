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
  // comments replaced
  src = src.replace(/\/*[\s\S]*?\*\/|\/\/[^\r\n]*/g, ' ');
  // split to lines
  const lines = src.split(/\r\n?|\n/g);
  // tokenization
  return lines.map((line, i) => ({
    tokens: line.match(/[a-z_][a-z_0-9]*|\.?[0-9](?:[ep][\+\-]|[a-z0-9_\.])*|"(?:[^"\\]+|\\.)*"|'(?:[^'\\]+|\\.)*'|\+[\+=]|\-[\-=>]|<<=?|>>=?|<[%:]|[%:]>|%:(?=%:)?|[\*\/=!&|^<>]=|&&|\|\||::|\S/gi) || new Array<string>(),
    lineNumber: i+1,
    fileName: path,
  }));
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
  meaning: 'number' | 'variable' | 'flag' | 'variable-value' | 'controller' | 'inventory-item' | 'message' | 'room-object' | 'string' | 'word';
  value: number;
}

interface MathExpression {
  type: 'math';
  operator: '+' | '-' | '*' | '/';
  operands: [Expression, Expression];
}

type Expression = CallExpression | AndExpression | OrExpression | NotExpression | LiteralExpression | MathExpression | Uint8Expression;

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

const VALTYPES_BY_PREFIX = {
  m: 'message',
  c: 'controller',
  v: 'variable',
  f: 'flag',
  i: 'inventory-item',
  o: 'room-object',
  s: 'string',
  w: 'word',
} as const;
type prefix_t = keyof typeof VALTYPES_BY_PREFIX;

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

export default async function compile({ path }: { path: string }) {
  const [ src, dictionary, items ] = await Promise.all([
    fs.promises.readFile(path, {encoding:'utf-8'}),
    loadDictionary(osPath.resolve(path, '../words.txt')),
    loadItems(osPath.resolve(path, '../items.txt')),
  ]);
  const tokenLines = tokenize(src, path);
  // directive handling
  const simpleMacros = new Map<string, string[]>();
  let ifStack = new Array<{ifLine:{lineNumber: number, fileName: string}, elseLine?:{lineNumber: number, fileName: string}}>();
  const messageNumbers = new Map<string, number>();
  const messages = new Array<string>();
  let nextFreeMessageNumber = 0;
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
        case 'ifdef': case 'ifndef': {
          if (line.tokens.length !== 3 || !isKeywordToken(line.tokens[2])) {
            throw new LineSyntaxError(line, `invalid #${line.tokens[1]} directive`);
          }
          const conditional = line.tokens[1] === 'ifndef' ? !simpleMacros.has(line.tokens[2]) : simpleMacros.has(line.tokens[2]);
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
        case 'else': {
          if (line.tokens.length !== 2) {
            throw new LineSyntaxError(line, `invalid #else directive`);
          }
          line.tokens.length = 0;
          if (ifStack.length === 0 || ifStack[ifStack.length-1].elseLine) {
            throw new LineSyntaxError(line, 'unmatched #else directive');
          }
          ifStack[ifStack.length-1].elseLine = line;
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
            if (!dictionary.byWord.has(strLiteral)) {
              throw new LineSyntaxError(line, `word not found in dictionary: ` + strLiteral);
            }
            params[param_i] = {
              type: 'uint8',
              meaning: 'word',
              value: dictionary.byWord.get(strLiteral)!,
            };
          }
          else if (commandParams[param_i] === 'inventory-item') {
            if (!items.byName.has(strLiteral)) {
              throw new LineSyntaxError(line, `unknown inventory item: ${strLiteral}`);
            }
            params[param_i] = {
              type: 'uint8',
              meaning: 'inventory-item',
              value: items.byName.get(strLiteral)!,
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
  const OP_PRECEDENCE = new Map([
    ['||', 0],
    ['&&', 1],
    ['==', 2], ['!=', 2],
    ['<', 3], ['<=', 3], ['>', 3], ['>=', 3],
    ['+', 4], ['-', 4],
    ['*', 5], ['/', 5],
  ]);
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
        return {
          type: 'uint8',
          meaning: VALTYPES_BY_PREFIX[token[0] as prefix_t],
          value: Number.parseInt(token.slice(1)),
        };
      }
      let func = token;
      if (tryToken('.')) {
        do {
          func += '.' + requireToken(isKeywordToken).token;
        } while (tryToken('.'));
      }
      requireToken('(');
      let params = new Array<Expression>();
      if (!tryToken(')')) {
        do {
          params.push(readExpression());
        } while (tryToken(','));
        requireToken(')');
      }
      if (!testCommandsByName.has(func)) {
        throw new LineSyntaxError(line, 'unknown function: '+func);
      }
      const testCommand = testCommandsByName.get(func)!;
      if (testCommand.params === 'vararg') {
        params = params.map(v => {
          if (v.type === 'literal' && isStringLiteralToken(v.literal)) {
            const word = decodeStringLiteral(v.literal);
            if (!dictionary.byWord.has(word)) {
              throw new LineSyntaxError(line, 'word not found in dictionary: ' + word);
            }
            return {type:'uint8', meaning:'word', value:dictionary.byWord.get(word)!};
          }
          if (v.type === 'uint8' && v.meaning === 'word') {
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
  console.log(JSON.stringify(statements, null, 2));
}
