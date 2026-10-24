import { builtinModules } from 'node:module';
import path from 'node:path';
import { loadConfig, createMatchPath } from 'tsconfig-paths';
import { config, languageOf, type Language } from '../config.js';

const TS_EXTENSIONS = config.languages.typescript.extensions;
const posix = (p: string) => p.split(path.sep).join('/');

export type Resolver = (fromRel: string, specifier: string) => string | null;

/**
 * Returns resolve(fromRel, specifier) -> relative path of an indexed file, or null for
 * packages, unresolved aliases and anything outside the indexed set.
 * TypeScript uses the tsconfig.json at the root for `paths` / `baseUrl` aliases;
 * Python resolves dotted and relative module names to `.py` / `__init__.py` files.
 */
export function createResolver(root: string, knownFiles: Set<string>): Resolver {
  const cfg = loadConfig(root);
  const matchPath = cfg.resultType === 'success' ? createMatchPath(cfg.absoluteBaseUrl, cfg.paths) : null;

  const lookup = (abs: string): string | null => {
    const rel = posix(path.relative(root, abs));
    const stem = rel.replace(/\.(m?js|jsx)$/, '');
    const candidates = [rel];
    for (const base of new Set([rel, stem])) {
      for (const ext of TS_EXTENSIONS) candidates.push(base + ext);
    }
    for (const ext of TS_EXTENSIONS) candidates.push(`${rel}/index${ext}`);
    return candidates.find((c) => knownFiles.has(c)) ?? null;
  };

  const resolveTs: Resolver = (fromRel, specifier) => {
    if (specifier.startsWith('.')) return lookup(path.resolve(root, path.dirname(fromRel), specifier));
    if (!matchPath) return null;
    const matched = matchPath(specifier, undefined, undefined, TS_EXTENSIONS);
    return matched ? lookup(matched) : null;
  };

  const pyModule = (dir: string, parts: string[]): string | null => {
    for (let n = parts.length; n >= 1; n--) {
      const base = posix(path.join(dir, ...parts.slice(0, n)));
      if (knownFiles.has(`${base}.py`)) return `${base}.py`;
      if (knownFiles.has(`${base}/__init__.py`)) return `${base}/__init__.py`;
    }
    return null;
  };

  const resolvePy: Resolver = (fromRel, specifier) => {
    const level = specifier.length - specifier.replace(/^\.+/, '').length;
    const parts = specifier.slice(level).split('.').filter(Boolean);
    if (level > 0) {
      let dir = path.dirname(fromRel);
      for (let i = 1; i < level; i++) dir = path.dirname(dir);
      if (!parts.length) return knownFiles.has(posix(path.join(dir, '__init__.py'))) ? posix(path.join(dir, '__init__.py')) : null;
      return pyModule(dir, parts);
    }
    return pyModule('', parts) ?? pyModule('src', parts);
  };

  return (fromRel, specifier) => {
    switch (languageOf(fromRel)) {
      case 'python': return resolvePy(fromRel, specifier);
      case 'typescript': return resolveTs(fromRel, specifier);
      default: return null; // C# edges are type-based, see dotnet.ts
    }
  };
}

const NODE_BUILTINS = new Set(builtinModules);

/** Package name for a specifier that is not a file in the service, or null if it is not a package. */
export function externalPackage(specifier: string, language: Language): string | null {
  if (specifier.startsWith('.')) return null;
  if (language === 'csharp') return null;
  if (language === 'python') return specifier.split('.')[0] || null;
  if (specifier.startsWith('node:') || specifier.startsWith('@/') || specifier.startsWith('~')) return null;
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
  return NODE_BUILTINS.has(name) ? null : name;
}
