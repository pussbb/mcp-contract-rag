import path from 'node:path';
import { mcpAddCommand, installHooks, installSkill, HOOKS } from './hooks/install.js';
import { runHook } from './hooks/run.js';

const [command, ...args] = process.argv.slice(2);

const HELP = `contract-rag <command>

  serve                          run the MCP server on stdio
  index [--service=N] [--root=P] sync the index now
  usage                          show recorded tool calls
  hook <sync|usage|context>      Claude Code hook handler (reads the event on stdin)
  install-hooks [dir] [--shared] add the hooks to a project's Claude Code settings
  uninstall-hooks [dir] [--shared]
  install-skill [dir]            add the contract-rag skill (.claude/skills/contract-rag) to a project
`;

switch (command) {
  case 'serve':
    await import('./server/index.js');
    break;
  case 'index':
    await (await import('./parser/indexer.js')).runIndexCli(args);
    break;
  case 'usage':
    await import('./usage-cli.js');
    break;
  case 'hook':
    await runHook(args[0]);
    break;
  case 'install-hooks':
  case 'uninstall-hooks': {
    const uninstall = command === 'uninstall-hooks';
    const projectDir = path.resolve(args.find((a) => !a.startsWith('--')) ?? process.cwd());
    const { file, changed } = installHooks({ projectDir, shared: args.includes('--shared'), uninstall });
    console.log(`${uninstall ? 'Removed hooks from' : changed ? 'Installed hooks in' : 'Hooks already up to date in'} ${file}`);
    if (!uninstall) {
      for (const h of HOOKS) console.log(`  ${h.event}${h.matcher ? ` (${h.matcher})` : ''} -> hook ${h.hook}`);
      console.log(`\nRegister the MCP server for that project (once):\n  cd ${projectDir} && ${mcpAddCommand()}`);
    }
    break;
  }
  case 'install-skill': {
    const projectDir = path.resolve(args.find((a) => !a.startsWith('--')) ?? process.cwd());
    const { file, changed } = installSkill(projectDir);
    console.log(`${changed ? 'Wrote' : 'Skill already up to date at'} ${file}`);
    break;
  }
  default:
    console.log(HELP);
    process.exitCode = command ? 1 : 0;
}
