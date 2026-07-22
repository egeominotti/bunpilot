// ---------------------------------------------------------------------------
// bunpilot – CLI Command: start
// ---------------------------------------------------------------------------
//
// Start an application. Accepts either a script path with inline flags or
// a config file via --config.
// ---------------------------------------------------------------------------

import { loadConfig, loadFromCLI } from '../../config/loader';
import type { AppConfig } from '../../config/types';
import { log, logError, logSuccess } from '../format';
import { extractEnv } from '../index';
import { sendCommand } from './_connect';

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function startCommand(
  args: string[],
  flags: Record<string, string | boolean>,
): Promise<void> {
  // ---- Config-file mode ----
  if (flags.config) {
    const configPath = typeof flags.config === 'string' ? flags.config : undefined;
    const bunpilotConfig = await loadConfig(configPath).catch((err) => {
      logError(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });

    if (bunpilotConfig.apps.length === 0) {
      logError('No apps defined in config file');
      process.exit(1);
    }

    // Start all apps from the config
    for (const app of bunpilotConfig.apps) {
      log('start', `Starting "${app.name}" ...`);
      await sendCommand('start', { name: app.name, config: app }, { silent: true });
      logSuccess(`"${app.name}" started`);
    }
    return;
  }

  // ---- Inline mode (script path required) ----
  const script = args[0];
  if (!script) {
    logError('Missing required argument: <script>');
    console.error('Usage: bunpilot start <script> [--name app] [--instances 4] [--port 3000]');
    process.exit(1);
  }

  // Auto-detect config files passed as positional argument (e.g. `bunpilot start my.config.ts`)
  if (isConfigFile(script)) {
    const bunpilotConfig = await loadConfig(script).catch((err) => {
      logError(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });

    if (bunpilotConfig.apps.length === 0) {
      logError('No apps defined in config file');
      process.exit(1);
    }

    for (const app of bunpilotConfig.apps) {
      log('start', `Starting "${app.name}" ...`);
      await sendCommand('start', { name: app.name, config: app }, { silent: true });
      logSuccess(`"${app.name}" started`);
    }
    return;
  }

  let instances: number | 'max' | undefined;
  if (flags.instances) {
    if (flags.instances === 'max') {
      instances = 'max';
    } else {
      const raw = String(flags.instances);
      const parsed = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed)) {
        logError(
          `Invalid --instances value: "${String(flags.instances)}". Expected a number or "max".`,
        );
        process.exit(1);
      }
      if (parsed < 1) {
        logError(`Invalid --instances value: "${String(flags.instances)}". Must be at least 1.`);
        process.exit(1);
      }
      instances = parsed;
    }
  }

  let port: number | undefined;
  if (flags.port) {
    const raw = String(flags.port);
    const parsed = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed)) {
      logError(`Invalid --port value: "${String(flags.port)}". Expected a number.`);
      process.exit(1);
    }
    if (parsed < 1 || parsed > 65535) {
      logError(`Invalid --port value: "${String(flags.port)}". Must be between 1 and 65535.`);
      process.exit(1);
    }
    port = parsed;
  }
  const env = extractEnv(flags);

  const config: AppConfig = loadFromCLI({
    script,
    name: typeof flags.name === 'string' ? flags.name : undefined,
    instances,
    port,
    env,
  });

  const name = config.name;

  log('start', `Starting "${name}" ...`);
  await sendCommand('start', { name, config }, { silent: true });
  logSuccess(`"${name}" started`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONFIG_PATTERNS = ['.config.ts', '.config.js', 'bunpilot.json'];

/** Check if a path looks like a bunpilot config file rather than a script. */
function isConfigFile(path: string): boolean {
  return CONFIG_PATTERNS.some((p) => path.endsWith(p));
}
