#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// bunpm – Main Entry Point
// ---------------------------------------------------------------------------
//
// Parses CLI arguments and routes to the appropriate command handler.
// Command modules are dynamically imported to keep startup fast.
// ---------------------------------------------------------------------------

import { parseArgs } from './cli/index';
import { logError } from './cli/format';
import { ensureBunpmHome } from './constants';

// ---------------------------------------------------------------------------
// ANSI helpers (local — avoid pulling the full format module for help text)
// ---------------------------------------------------------------------------

const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

const VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// Help Text
// ---------------------------------------------------------------------------

function showHelp(): void {
  const bin = 'bunpm';

  console.log(`
${BOLD}${bin}${RESET} — Bun-native process manager

${BOLD}Usage:${RESET}
  ${bin} <command> [args] [flags]

${BOLD}Process Commands:${RESET}
  ${GREEN}start${RESET} <script|config>     Start a process (or cluster)
  ${GREEN}stop${RESET} <name|id|all>        Stop a running process
  ${GREEN}restart${RESET} <name|id|all>     Restart a process (stop + start)
  ${GREEN}reload${RESET} <name|id|all>      Gracefully reload (zero-downtime)
  ${GREEN}delete${RESET} <name|id|all>      Stop and remove a process        ${BOLD}aliases:${RESET} del

${BOLD}Inspection Commands:${RESET}
  ${GREEN}list${RESET}                      List all managed processes        ${BOLD}aliases:${RESET} ls
  ${GREEN}status${RESET} <name|id>          Show detailed process info        ${BOLD}aliases:${RESET} info
  ${GREEN}logs${RESET} [name|id]            Stream process log output         ${BOLD}aliases:${RESET} log
  ${GREEN}metrics${RESET}                   Live CPU / memory dashboard       ${BOLD}aliases:${RESET} monit

${BOLD}Daemon Commands:${RESET}
  ${GREEN}daemon${RESET} <start|stop|status> Manage the background daemon
  ${GREEN}ping${RESET}                       Check if the daemon is alive

${BOLD}Other:${RESET}
  ${GREEN}init${RESET}                      Generate an ecosystem config file

${BOLD}Global Flags:${RESET}
  --help, -h                  Show this help message
  --version, -v               Show version number
  --json                      Output as JSON where supported
  --force                     Force the operation
`);
}

function showVersion(): void {
  console.log(`bunpm v${VERSION}`);
}

// ---------------------------------------------------------------------------
// Command Router
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  ensureBunpmHome();

  const parsed = parseArgs(process.argv);
  const { command, args, flags } = parsed;

  try {
    switch (command) {
      // -- Process commands --------------------------------------------------

      case 'start': {
        const { startCommand } = await import('./cli/commands/start');
        await startCommand(args, flags);
        break;
      }

      case 'stop': {
        const { stopCommand } = await import('./cli/commands/stop');
        await stopCommand(args, flags);
        break;
      }

      case 'restart': {
        const { restartCommand } = await import('./cli/commands/restart');
        await restartCommand(args, flags);
        break;
      }

      case 'reload': {
        const { reloadCommand } = await import('./cli/commands/reload');
        await reloadCommand(args, flags);
        break;
      }

      case 'delete':
      case 'del': {
        const { deleteCommand } = await import('./cli/commands/delete');
        await deleteCommand(args, flags);
        break;
      }

      // -- Inspection commands -----------------------------------------------

      case 'list':
      case 'ls': {
        const { listCommand } = await import('./cli/commands/list');
        await listCommand(args, flags);
        break;
      }

      case 'status':
      case 'info': {
        const { statusCommand } = await import('./cli/commands/status');
        await statusCommand(args, flags);
        break;
      }

      case 'logs':
      case 'log': {
        const { logsCommand } = await import('./cli/commands/logs');
        await logsCommand(args, flags);
        break;
      }

      case 'metrics':
      case 'monit': {
        const { metricsCommand } = await import('./cli/commands/metrics');
        await metricsCommand(args, flags);
        break;
      }

      // -- Daemon commands ---------------------------------------------------

      case 'daemon': {
        const { daemonCommand } = await import('./cli/commands/daemon');
        await daemonCommand(args, flags);
        break;
      }

      case 'ping': {
        const { pingCommand } = await import('./cli/commands/ping');
        await pingCommand(args, flags);
        break;
      }

      // -- Other -------------------------------------------------------------

      case 'init': {
        const { initCommand } = await import('./cli/commands/init');
        await initCommand(args, flags);
        break;
      }

      // -- No command / fallback ---------------------------------------------

      case '': {
        if (flags.version) {
          showVersion();
        } else {
          showHelp();
        }
        break;
      }

      default: {
        logError(`Unknown command: "${command}"`);
        showHelp();
        process.exit(1);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(message);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main();
