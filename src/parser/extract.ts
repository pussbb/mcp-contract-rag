import path from 'node:path';
import { parse, type ParserPlugin } from '@babel/parser';
import type { Comment } from '@babel/types';

// Babel node with loose property access: the extractor duck-types over many node shapes.
type AstNode = Record<string, any>;

export type EntityType = 'component' | 'hook' | 'function' | 'class' | 'abstract_class' | 'interface' | 'type' | 'enum' | 'const';

export interface ExtractedExport {
  name: string;
  /** Entity kind; the set differs per language (see EntityType for TypeScript). */
  type: string;
  /** C# only: namespace the type is declared in. */
  namespace?: string;
  signature: string;
  description: string | null;
}

export interface Analysis {
  exports: ExtractedExport[];
  imports: string[];
  /** C# only: identifiers used in the file, for type-reference edges. */
  references?: string[];
  /** Field-level usage: which local variables hold imported entities and which fields are accessed. */
  fieldUsage?: FieldUsage[];
  /** Name of the entity exported as `default`, if any. */
  defaultExport?: string;
}

export interface FieldUsage {
  /** Module specifier the entity is imported from, as written (e.g. '../hooks/useAuth'). */
  source: string;
  /** The exported name in that module (e.g. 'useAuth'); 'default' for a default import. */
  entityName: string;
  /** Fields read from the entity's result, with the number of reads in this file. */
  fields: Array<{ name: string; count: number }>;
}

interface Described {
  type: EntityType;
  signature: string;
}

interface LocalEntry {
  node: AstNode;
  declarator?: AstNode;
}

const MAX_SIGNATURE_LENGTH = 1200;
const MAX_DESCRIPTION_LENGTH = 400;
const MAX_CLASS_MEMBERS_TO_SHOW = 20;

/**
 * Parse one source file and return its exported contracts and raw import specifiers.
 * Re-exports (`export { x } from './y'`) produce no contract, only an import specifier,
 * so the graph edge points at the barrel and the barrel's own edge points at the provider.
 */
export function analyzeSource(code: string, filePath: string): Analysis {
  const isTs = /\.tsx?$/.test(filePath);
  const isJsxFile = /\.[tj]sx$/.test(filePath);
  const plugins: ParserPlugin[] = ['decorators-legacy'];
  if (isTs) plugins.push('typescript');
  if (!isTs || isJsxFile) plugins.push('jsx');
  const ast = parse(code, { sourceType: 'module', plugins, errorRecovery: true });
  const body = ast.program.body as AstNode[];
  const slice = (n: AstNode) => code.slice(n.start, n.end);

  const locals = new Map<string, LocalEntry>();
  const imports: string[] = [];
  // local name -> where it was imported from, for field usage analysis
  const importBindings = new Map<string, ImportBinding>();
  let defaultExport: string | undefined;
  for (const stmt of body) {
    const decl = stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration'
      ? stmt.declaration : stmt;
    if (!decl) continue;
    if (decl.type === 'VariableDeclaration') {
      for (const d of decl.declarations) if (d.id.type === 'Identifier') locals.set(d.id.name, { node: decl, declarator: d });
    } else if (decl.id?.name) {
      locals.set(decl.id.name, { node: decl });
    }
  }

  const found = new Map<string, ExtractedExport>();
  const add = (name: string, { type, signature }: Described, commentHost: AstNode | undefined): void => {
    const existing = found.get(name);
    if (existing && existing.type === 'function' && type === 'function') {
      existing.signature = truncate(`${existing.signature}\n${signature}`, MAX_SIGNATURE_LENGTH);
      return;
    }
    if (existing) return;
    found.set(name, { name, type, signature, description: jsdoc(commentHost) });
  };

  const describeEntry = (entry: LocalEntry, name: string): Described => {
    const { node, declarator } = entry;
    return declarator ? describeDeclarator(declarator, name) : describeDecl(node, name);
  };

  const describeDecl = (node: AstNode, name: string): Described => {
    switch (node.type) {
      case 'FunctionDeclaration':
      case 'TSDeclareFunction':
        return { type: kindOfCallable(name), signature: truncate(header(node), MAX_SIGNATURE_LENGTH) };
      case 'ClassDeclaration':
        return { type: node.abstract ? 'abstract_class' : 'class', signature: classSignature(node) };
      case 'TSInterfaceDeclaration':
        return { type: 'interface', signature: truncate(slice(node), MAX_SIGNATURE_LENGTH) };
      case 'TSTypeAliasDeclaration':
        return { type: 'type', signature: truncate(slice(node), MAX_SIGNATURE_LENGTH) };
      case 'TSEnumDeclaration':
        return { type: 'enum', signature: truncate(slice(node), MAX_SIGNATURE_LENGTH) };
      default:
        return { type: 'const', signature: `export default ${node.type}` };
    }
  };

  const describeDeclarator = (d: AstNode, name: string): Described => {
    const idText = slice(d.id);
    const init = d.init;
    if (init && (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression')) {
      return { type: kindOfCallable(name), signature: truncate(`const ${idText} = ${code.slice(init.start, init.body.start).trim()}`, MAX_SIGNATURE_LENGTH) };
    }
    let signature = `const ${idText}`;
    if (init?.type === 'CallExpression') signature += ` = ${slice(init.callee)}(…)`;
    else if (init && /Literal$/.test(init.type) && !d.id.typeAnnotation) signature += ` = ${truncate(slice(init), 80)}`;
    const type: EntityType = /^[A-Z]/.test(name) && init?.type === 'CallExpression' && isJsxFile ? 'component' : /^use[A-Z]/.test(name) ? 'hook' : 'const';
    return { type, signature };
  };

  const header = (fn: AstNode): string => {
    const end = fn.body ? fn.body.start : fn.end;
    return code.slice(fn.start, end).trim().replace(/;$/, '');
  };

  const kindOfCallable = (name: string): EntityType => {
    if (/^use[A-Z]/.test(name)) return 'hook';
    if (/^[A-Z]/.test(name) && isJsxFile) return 'component';
    return 'function';
  };

  const classSignature = (node: AstNode): string => {
    const head = code.slice(node.start, node.body.start).trim();
    const members = node.body.body
      .filter((m: AstNode) => !m.accessibility || m.accessibility === 'public')
      .filter((m: AstNode) => m.key && m.key.type !== 'PrivateName')
      .slice(0, MAX_CLASS_MEMBERS_TO_SHOW)
      .map((m: AstNode) => `  ${(m.body ? code.slice(m.start, m.body.start) : slice(m)).trim().replace(/;$/, '')}`);
    return truncate(`${head} {\n${members.join('\n')}\n}`, MAX_SIGNATURE_LENGTH);
  };

  for (const stmt of body) {
    switch (stmt.type) {
      case 'ImportDeclaration':
        imports.push(stmt.source.value);
        // Track import bindings for field usage analysis
        for (const spec of stmt.specifiers) {
          if (spec.type === 'ImportSpecifier') {
            importBindings.set(spec.local.name, { source: stmt.source.value, imported: spec.imported.name ?? spec.imported.value });
          } else if (spec.type === 'ImportDefaultSpecifier') {
            importBindings.set(spec.local.name, { source: stmt.source.value, imported: 'default' });
          }
        }
        break;
      case 'ExportAllDeclaration':
        imports.push(stmt.source.value);
        break;
      case 'ExportNamedDeclaration': {
        if (stmt.source) { imports.push(stmt.source.value); break; }
        if (stmt.declaration) {
          const decl = stmt.declaration;
          if (decl.type === 'VariableDeclaration') {
            for (const d of decl.declarations) if (d.id.type === 'Identifier') add(d.id.name, describeDeclarator(d, d.id.name), stmt);
          } else if (decl.id?.name) {
            add(decl.id.name, describeDecl(decl, decl.id.name), stmt);
          }
        } else {
          for (const spec of stmt.specifiers) {
            if (spec.type !== 'ExportSpecifier') continue;
            const exported = spec.exported.name ?? spec.exported.value;
            const entry = locals.get(spec.local.name);
            if (entry) add(exported, describeEntry(entry, exported), entry.declarator ? entry.node : entry.node);
          }
        }
        break;
      }
      case 'ExportDefaultDeclaration': {
        const decl = stmt.declaration;
        defaultExport = decl.type === 'Identifier' ? decl.name : decl.id?.name ?? defaultName(filePath);
        if (decl.type === 'Identifier') {
          const entry = locals.get(decl.name);
          if (entry) add(decl.name, describeEntry(entry, decl.name), entry.node);
          break;
        }
        const name = decl.id?.name ?? defaultName(filePath);
        if (decl.type === 'ArrowFunctionExpression' || decl.type === 'FunctionExpression') {
          add(name, { type: kindOfCallable(name), signature: truncate(`${code.slice(decl.start, decl.body.start).trim()}`, MAX_SIGNATURE_LENGTH) }, stmt);
        } else if (decl.type === 'CallExpression') {
          add(name, { type: kindOfCallable(name), signature: `${slice(decl.callee)}(…)` }, stmt);
        } else {
          add(name, describeDecl(decl, name), stmt);
        }
        break;
      }
      default:
    }
  }

  // Analyze field usage patterns
  const fieldUsage = analyzeFieldUsage(body, importBindings);

  return { exports: [...found.values()], imports, fieldUsage, defaultExport };

  function jsdoc(host: AstNode | undefined): string | null {
    const comments = host?.leadingComments ?? [];
    const c = comments.at(-1);
    return c ? cleanJsdoc(c) : null;
  }
}

export function cleanJsdoc(comment: Comment): string | null {
  if (comment.type !== 'CommentBlock' || !comment.value.startsWith('*')) return null;
  const lines = comment.value.split('\n').map((l: string) => l.replace(/^\s*\*+ ?/, '').trim());
  const summary: string[] = [];
  let deprecated = false;
  for (const line of lines) {
    if (line.startsWith('@')) {
      if (line.startsWith('@deprecated')) deprecated = true;
      continue;
    }
    if (line) summary.push(line);
  }
  let text = summary.join(' ').replace(/\{@link\s+([^}\s|]+)[^}]*\}/g, '$1').replace(/\s+/g, ' ').trim();
  if (deprecated) text = `[deprecated] ${text}`.trim();
  return text ? truncate(text, MAX_DESCRIPTION_LENGTH) : null;
}

function defaultName(filePath: string): string {
  const base = path.basename(filePath).replace(/\.[^.]+$/, '');
  return base === 'index' ? path.basename(path.dirname(filePath)) : base;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

interface ImportBinding {
  source: string;
  imported: string;
}

/**
 * Counts the fields read from imported values. Recognized shapes, for an imported `useAuth`:
 * `const { user, isViewer: v } = useAuth()`, `const auth = useAuth(); auth.user / auth?.user`,
 * `const { user } = auth`, and the same destructuring/member access on an imported value directly.
 * Scopes are ignored, so a shadowing local with the same name is counted too.
 */
function analyzeFieldUsage(body: AstNode[], importBindings: Map<string, ImportBinding>): FieldUsage[] {
  const aliases = new Map<string, ImportBinding>(); // local variable -> the import it holds the result of
  const counts = new Map<string, { binding: ImportBinding; fields: Map<string, number> }>();

  const bindingOf = (expr: AstNode | null | undefined): ImportBinding | undefined => {
    if (!expr) return undefined;
    if (expr.type === 'AwaitExpression' || expr.type === 'TSNonNullExpression' || expr.type === 'TSAsExpression') return bindingOf(expr.argument ?? expr.expression);
    if (expr.type === 'CallExpression' && expr.callee.type === 'Identifier') return importBindings.get(expr.callee.name);
    if (expr.type === 'Identifier') return aliases.get(expr.name) ?? importBindings.get(expr.name);
    return undefined;
  };

  const record = (binding: ImportBinding, field: string): void => {
    const key = `${binding.source}\u0000${binding.imported}`;
    let entry = counts.get(key);
    if (!entry) counts.set(key, (entry = { binding, fields: new Map() }));
    entry.fields.set(field, (entry.fields.get(field) ?? 0) + 1);
  };

  const walk = (node: AstNode | null | undefined, visit: (n: AstNode) => void): void => {
    if (!node || typeof node.type !== 'string') return;
    visit(node);
    for (const key of Object.keys(node)) {
      if (key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
      const child = node[key];
      if (Array.isArray(child)) for (const c of child) walk(c, visit);
      else if (child && typeof child === 'object') walk(child, visit);
    }
  };

  // Pass 1: `const x = useAuth()` / `const x = other` aliases. Repeat so an alias of an alias resolves.
  for (let round = 0; round < 2; round++) {
    for (const stmt of body) {
      walk(stmt, (n) => {
        if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier') {
          const binding = bindingOf(n.init);
          if (binding) aliases.set(n.id.name, binding);
        }
      });
    }
  }

  // Pass 2: destructuring and member access.
  for (const stmt of body) {
    walk(stmt, (n) => {
      if (n.type === 'VariableDeclarator' && n.id.type === 'ObjectPattern') {
        const binding = bindingOf(n.init);
        if (!binding) return;
        for (const prop of n.id.properties) {
          if (prop.type !== 'ObjectProperty') continue;
          if (prop.key.type === 'Identifier' && !prop.computed) record(binding, prop.key.name);
          else if (prop.key.type === 'StringLiteral') record(binding, prop.key.value);
        }
      } else if ((n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression') && n.object.type === 'Identifier') {
        const binding = aliases.get(n.object.name);
        if (!binding) return;
        if (!n.computed && n.property.type === 'Identifier') record(binding, n.property.name);
        else if (n.computed && n.property.type === 'StringLiteral') record(binding, n.property.value);
      }
    });
  }

  return [...counts.values()].map(({ binding, fields }) => ({
    source: binding.source,
    entityName: binding.imported,
    fields: [...fields].map(([name, count]) => ({ name, count })),
  }));
}
