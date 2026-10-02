import * as acorn from 'acorn';
import { Binary, Decimal128, Int32, Long, MaxKey, MinKey, ObjectId, Timestamp, UUID } from 'mongodb';

type Node = acorn.AnyNode;

class FilterSyntaxError extends Error {}

/** As in the shell: now, a string or milliseconds, or numbers (year, month, …) in local time. */
const date = (...a: unknown[]): Date => {
  if (a.length > 1 && a.some((x) => typeof x !== 'number')) throw new FilterSyntaxError('Date(year, month, …) takes numbers only.');
  return a.length === 0 ? new Date() : (Reflect.construct(Date, a) as Date);
};

/** Shell helpers the viewer accepts, called with already-parsed literal arguments. */
const HELPERS: Record<string, (...a: unknown[]) => unknown> = {
  ObjectId: (hex?: unknown) => (hex === undefined ? new ObjectId() : new ObjectId(String(hex))),
  ISODate: date,
  Date: date,
  UUID: (s?: unknown) => (s === undefined ? new UUID() : new UUID(String(s))),
  NumberLong: (v: unknown) => Long.fromString(String(v)),
  NumberInt: (v: unknown) => new Int32(Number(v)),
  NumberDecimal: (v: unknown) => Decimal128.fromString(String(v)),
  Decimal128: (v: unknown) => Decimal128.fromString(String(v)),
  BinData: (subtype: unknown, base64: unknown) => new Binary(Buffer.from(String(base64), 'base64'), Number(subtype)),
  Timestamp: (t: unknown, i: unknown) => new Timestamp({ t: Number(t), i: Number(i) }),
  MinKey: () => new MinKey(),
  MaxKey: () => new MaxKey(),
};

const reject = (node: Node, what: string): never => {
  throw new FilterSyntaxError(`${what} is not allowed here (position ${node.start}): only { key: value } objects, arrays, literals and ${Object.keys(HELPERS).join(', ')}.`);
};

/** Builds the value of one AST node, refusing anything that could run code. */
function value(node: Node, src: string): unknown {
  switch (node.type) {
    case 'ObjectExpression': {
      const out: Record<string, unknown> = {};
      for (const p of node.properties) {
        if (p.type !== 'Property' || p.kind !== 'init' || p.method || p.computed) return reject(p, 'This property');
        const key = p.key.type === 'Identifier' ? p.key.name : p.key.type === 'Literal' && (typeof p.key.value === 'string' || typeof p.key.value === 'number') ? String(p.key.value) : reject(p.key, 'This key');
        // Shorthand `{ a }` refers to a variable, which the viewer has none of.
        if (p.shorthand) return reject(p, `The shorthand property "${key}"`);
        out[key] = value(p.value, src);
      }
      return out;
    }
    case 'ArrayExpression':
      return node.elements.map((e) => (e === null || e.type === 'SpreadElement' ? reject(e ?? node, 'An empty or spread element') : value(e, src)));
    case 'Literal':
      if ('regex' in node && node.regex) return new RegExp(node.regex.pattern, node.regex.flags);
      if (typeof node.value === 'bigint') return reject(node, 'A BigInt literal');
      return node.value;
    case 'UnaryExpression':
      if ((node.operator === '-' || node.operator === '+') && node.argument.type === 'Literal' && typeof node.argument.value === 'number') {
        return node.operator === '-' ? -node.argument.value : node.argument.value;
      }
      return reject(node, `The operator ${node.operator}`);
    case 'CallExpression':
    case 'NewExpression': {
      const callee = node.callee;
      if (callee.type !== 'Identifier' || !Object.prototype.hasOwnProperty.call(HELPERS, callee.name)) {
        return reject(node, `The call ${src.slice(callee.start, callee.end)}(…)`);
      }
      const args = node.arguments.map((a) => (a.type === 'SpreadElement' ? reject(a, 'A spread argument') : value(a, src)));
      if (args.some((a) => a !== null && typeof a === 'object')) return reject(node, `An object argument to ${callee.name}`);
      return HELPERS[callee.name](...args);
    }
    case 'Identifier':
      return reject(node, `The name "${node.name}"`);
    case 'TemplateLiteral':
    case 'TaggedTemplateExpression':
      return reject(node, 'A template literal');
    case 'MemberExpression':
      return reject(node, 'A member access');
    default:
      return reject(node, `A ${node.type}`);
  }
}

/**
 * Parses a filter / sort / projection object typed in the collection viewer without
 * running it: shell object-literal syntax only (see HELPERS), so pasted text cannot
 * reach the extension host.
 */
export function parseFilter(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  let program: acorn.Program;
  try {
    program = acorn.parse(`(${text}\n)`, { ecmaVersion: 'latest', sourceType: 'script' });
  } catch (err) {
    throw new SyntaxError(`Not a valid object: ${(err as Error).message.replace(/\s*\(\d+:\d+\)$/, '')}`);
  }
  const [statement, ...rest] = program.body;
  if (!statement || rest.length || statement.type !== 'ExpressionStatement') throw new SyntaxError(`Expected one object like { field: value }, got: ${text}`);
  const expr = statement.expression;
  if (expr.type !== 'ObjectExpression') throw new SyntaxError(`Expected an object like { field: value }, got: ${text}`);
  return value(expr, `(${text}\n)`) as Record<string, unknown>;
}
