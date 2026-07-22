// ---------------------------------------------------------------------------
// bunpilot – Validated config-file loading
// ---------------------------------------------------------------------------

import { extname, join, resolve } from 'node:path';
import { CONFIG_FILES } from '../constants';
import type { BunpilotConfig } from './types';
import { validateConfig } from './validator';

async function discoverConfigFile(dir: string): Promise<string | null> {
  for (const filename of CONFIG_FILES) {
    const candidate = join(dir, filename);
    if (await Bun.file(candidate).exists()) return candidate;
  }
  return null;
}

async function loadModule(absolutePath: string): Promise<unknown> {
  const mod = await import(absolutePath);
  if (mod.default === undefined) {
    throw new Error(`Config file "${absolutePath}" must have a default export.`);
  }
  return mod.default;
}

async function loadRawConfig(absolutePath: string): Promise<unknown> {
  switch (extname(absolutePath)) {
    case '.ts':
    case '.js':
      return loadModule(absolutePath);
    case '.json':
      return Bun.file(absolutePath).json();
    default:
      throw new Error(
        `Unsupported config file extension "${extname(absolutePath)}". Use .ts, .js, or .json.`,
      );
  }
}

/** Load a config file (or discover one in cwd), validate it, and apply defaults. */
export async function loadConfigFile(configPath?: string): Promise<BunpilotConfig> {
  let resolvedPath: string;

  if (configPath) {
    resolvedPath = resolve(configPath);
    if (!(await Bun.file(resolvedPath).exists())) {
      throw new Error(`Config file not found: ${resolvedPath}`);
    }
  } else {
    const discovered = await discoverConfigFile(process.cwd());
    if (!discovered) {
      throw new Error(`No config file found. Create one of: ${CONFIG_FILES.join(', ')}`);
    }
    resolvedPath = resolve(discovered);
  }

  return validateConfig(await loadRawConfig(resolvedPath));
}
