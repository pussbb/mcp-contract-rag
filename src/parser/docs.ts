import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import type { DocRecord } from '../db/docs.js';

const DOC_EXTENSIONS = config.docs.extensions;
const MAX_CONTENT_LENGTH = config.docs.maxContentLength;

/** Detect document language from file extension. */
export function detectLanguage(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.rst') return 'rst';
  if (ext === '.txt') return 'text';
  return 'unknown';
}

/** Calculate folder multiplier based on configured folder patterns. */
function getFolderMultiplier(filePath: string): number {
  const lowerPath = filePath.toLowerCase();
  for (const folder of config.docs.folders) {
    if (!folder.enabled) continue;
    if (lowerPath.includes(folder.path.toLowerCase())) {
      return folder.multiplier;
    }
  }
  return 1;
}

/** Walk a directory and find all documentation files. */
export async function crawlDocs(root: string, extraIgnoreDirs: string[] = []): Promise<string[]> {
  const ignored = new Set([...config.ignore.dirs, ...extraIgnoreDirs]);
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) await walk(path.join(dir, entry.name));
      } else if (entry.isFile() && DOC_EXTENSIONS.includes(path.extname(entry.name))) {
        files.push(path.relative(root, path.join(dir, entry.name)));
      }
    }
  }

  await walk(root);
  return files.sort();
}

/** Extract document content for indexing. */
export async function extractDoc(root: string, relPath: string): Promise<DocRecord | null> {
  const abs = path.join(root, relPath);
  const st = await stat(abs);
  const content = await readFile(abs, 'utf8');

  // Skip files that are too large
  if (content.length > MAX_CONTENT_LENGTH) {
    return null;
  }

  return {
    service: '', // Will be set by caller
    path: relPath,
    name: path.basename(relPath),
    hash: createHash('md5').update(content).digest('hex'),
    content,
    language: detectLanguage(relPath),
    size: st.size,
    mtime: Math.floor(st.mtimeMs),
    folderMultiplier: getFolderMultiplier(relPath),
  };
}

/** Extract multiple documents in parallel. */
export async function extractDocs(root: string, relPaths: string[]): Promise<DocRecord[]> {
  const results = await Promise.all(
    relPaths.map((rel) => extractDoc(root, rel).catch(() => null)),
  );
  return results.filter((r): r is DocRecord => r !== null);
}
