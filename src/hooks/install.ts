import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TSX = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const CLI = path.join(repoRoot, 'src', 'cli.ts');

const quote = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;
const command = (hook: string) => `${quote(TSX)} ${quote(CLI)} hook ${hook}`;

interface HookGroup {
  matcher?: string;
  hooks: { type: string; command: string; timeout?: number }[];
}
type Settings = { hooks?: Record<string, HookGroup[]> } & Record<string, unknown>;

const MCP_MATCHER = 'mcp__contract-rag__.*';

/** Hooks this project provides: which event, which tools, which `contract-rag hook` handler. */
export const HOOKS: { event: string; matcher?: string; hook: string; timeout: number }[] = [
  { event: 'PreToolUse', matcher: MCP_MATCHER, hook: 'sync', timeout: 15 },
  { event: 'PostToolUse', matcher: MCP_MATCHER, hook: 'usage', timeout: 10 },
  { event: 'UserPromptSubmit', hook: 'context', timeout: 10 },
];

const isOurs = (cmd: string) => cmd.includes(CLI) && / hook \w+$/.test(cmd);

export interface InstallOptions {
  projectDir: string;
  /** Write the committed .claude/settings.json instead of .claude/settings.local.json. */
  shared?: boolean;
  uninstall?: boolean;
}

/**
 * Adds (or removes) the contract-rag hooks in a project's Claude Code settings, leaving every
 * other setting and hook alone. Running it twice changes nothing. Paths are absolute, so the
 * default target is the untracked settings.local.json.
 */
export function installHooks({ projectDir, shared = false, uninstall = false }: InstallOptions): { file: string; changed: boolean } {
  const file = path.join(projectDir, '.claude', shared ? 'settings.json' : 'settings.local.json');
  const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const settings: Settings = before.trim() ? (JSON.parse(before) as Settings) : {};
  const hooks = (settings.hooks ??= {});

  // Drop our previous entries first, so install also repairs moved checkouts.
  for (const [event, groups] of Object.entries(hooks)) {
    const kept = groups
      .map((g) => ({ ...g, hooks: g.hooks.filter((h) => !isOurs(h.command)) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (!uninstall) {
    for (const h of HOOKS) {
      (hooks[h.event] ??= []).push({
        ...(h.matcher ? { matcher: h.matcher } : {}),
        hooks: [{ type: 'command', command: command(h.hook), timeout: h.timeout }],
      });
    }
  }
  if (!Object.keys(hooks).length) delete settings.hooks;

  const after = `${JSON.stringify(settings, null, 2)}\n`;
  const changed = after !== before && !(uninstall && !before);
  if (changed) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, after);
  }
  return { file, changed };
}

/** Shell command that registers the MCP server with Claude Code for a project. */
export function mcpAddCommand(): string {
  return `claude mcp add contract-rag -- ${quote(TSX)} ${quote(CLI)} serve`;
}
