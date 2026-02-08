// ---------------------------------------------------------------------------
// bunpm – Config File Loader
// ---------------------------------------------------------------------------

import { resolve, join, extname } from 'node:path';
import { CONFIG_FILES } from '../constants';
import type { BunpmConfig, AppConfig } from './types';
import { validateConfig, validateApp } from './validator';

// ---------------------------------------------------------------------------
// Config file discovery
// ---------------------------------------------------------------------------

/**
 * Search for a config file in the given directory.
 * Checks each candidate in CONFIG_FILES order and returns the first that exists.
 */
async function discoverConfigFile(dir: string): Promise<string | null> {
  for (const filename of CONFIG_FILES) {
    const candidate = join(dir, filename);
    const file = Bun.file(candidate);
    if (await file.exists()) {
      return candidate;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// File-type loaders
// ---------------------------------------------------------------------------

/**
 * Load a .ts or .js config file via dynamic import.
 * Expects a default export containing the raw config object.
 */
async function loadModule(absolutePath: string): Promise<unknown> {
  const mod = await import(absolutePath);
  if (mod.default === undefined) {
    throw new Error(`Config file "${absolutePath}" must have a default export.`);
  }
  return mod.default;
}

/**
 * Load a .json config file using Bun's native file API.
 */
async function loadJson(absolutePath: string): Promise<unknown> {
  return Bun.file(absolutePath).json();
}

/**
 * Dispatch to the correct loader based on file extension.
 */
async function loadRawConfig(absolutePath: string): Promise<unknown> {
  const ext = extname(absolutePath);
  switch (ext) {
    case '.ts':
    case '.js':
      return loadModule(absolutePath);
    case '.json':
      return loadJson(absolutePath);
    default:
      throw new Error(`Unsupported config file extension "${ext}". Use .ts, .js, or .json.`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load and validate a bunpm config.
 *
 * @param configPath - Explicit path to a config file. When omitted the
 *   current working directory is searched for the standard config filenames
 *   (bunpm.config.ts, bunpm.config.js, bunpm.json) in that order.
 *
 * @returns A fully validated `BunpmConfig` with all defaults applied.
 */
export async function loadConfig(configPath?: string): Promise<BunpmConfig> {
  let resolvedPath: string;

  if (configPath) {
    resolvedPath = resolve(configPath);
    const file = Bun.file(resolvedPath);
    if (!(await file.exists())) {
      throw new Error(`Config file not found: ${resolvedPath}`);
    }
  } else {
    const discovered = await discoverConfigFile(process.cwd());
    if (!discovered) {
      throw new Error(`No config file found. Create one of: ${CONFIG_FILES.join(', ')}`);
    }
    resolvedPath = resolve(discovered);
  }

  const raw = await loadRawConfig(resolvedPath);
  return validateConfig(raw);
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
 * (e.g. `bunpm start app.ts --instances 4 --port 3000`) instead of
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
  const base = script.split('/').pop() ?? script;
  const dotIndex = base.lastIndexOf('.');
  return dotIndex > 0 ? base.slice(0, dotIndex) : base;
}
