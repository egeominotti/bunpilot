// ---------------------------------------------------------------------------
// bunpilot – Config File Loader
// ---------------------------------------------------------------------------

import { loadConfigFile } from './file-loader';
import type { AppConfig } from './types';
import { validateApp } from './validator';

/** Public config loader kept here alongside the CLI config builder. */
export function loadConfig(configPath?: string) {
  return loadConfigFile(configPath);
}

// ---------------------------------------------------------------------------
// CLI helper
// ---------------------------------------------------------------------------

/** Shape of the CLI flags forwarded to `loadFromCLI`. */
export interface CLIArgs {
  script: string;
  instances?: number | 'max';
  port?: number;
  name?: string;
  env?: Record<string, string>;
}

/**
 * Build a validated `AppConfig` from CLI flags.
 *
 * This is used when the user starts a script directly from the CLI
 * (e.g. `bunpilot start app.ts --instances 4 --port 3000`) instead of
 * providing a config file.
 */
export function loadFromCLI(args: CLIArgs): AppConfig {
  const raw: Record<string, unknown> = {
    script: args.script,
    name: args.name ?? deriveAppName(args.script),
  };

  if (args.instances !== undefined) raw.instances = args.instances;
  if (args.port !== undefined) raw.port = args.port;
  if (args.env !== undefined) raw.env = args.env;

  return validateApp(raw);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive a human-friendly app name from a script path.
 *
 * Examples:
 *   "src/server.ts"  -> "server"
 *   "./app.js"       -> "app"
 *   "/opt/my-app.ts" -> "my-app"
 */
function deriveAppName(script: string): string {
  const base = script.split(/[\\/]/).pop() ?? script;
  const dotIndex = base.lastIndexOf('.');
  return dotIndex > 0 ? base.slice(0, dotIndex) : base;
}
