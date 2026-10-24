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

  return { exports: [...found.values()], imports };

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
