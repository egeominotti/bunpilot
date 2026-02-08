// ---------------------------------------------------------------------------
// bunpm2 – CLI Command: start
// ---------------------------------------------------------------------------
//
// Start an application. Accepts either a script path with inline flags or
// a config file via --config.
// ---------------------------------------------------------------------------

import { loadConfig, loadFromCLI } from '../../config/loader';
import { extractEnv } from '../index';
import { logError, logSuccess, log } from '../format';
import { sendCommand } from './_connect';
import type { AppConfig } from '../../config/types';

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function startCommand(
  args: string[],
  flags: Record<string, string | boolean>,
): Promise<void> {
  let config: AppConfig;
  let name: string;

  // ---- Config-file mode ----
  if (flags.config) {
    const configPath = typeof flags.config === 'string' ? flags.config : undefined;
    const bunpm2Config = await loadConfig(configPath).catch((err) => {
      logError(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });

    if (bunpm2Config.apps.length === 0) {
      logError('No apps defined in config file');
      process.exit(1);
    }

    // Start all apps from the config
    for (const app of bunpm2Config.apps) {
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
    console.error('Usage: bunpm2 start <script> [--name app] [--instances 4] [--port 3000]');
    process.exit(1);
  }

  const instances = flags.instances
    ? flags.instances === 'max'
      ? 'max'
      : parseInt(String(flags.instances), 10)
    : undefined;

  const port = flags.port ? parseInt(String(flags.port), 10) : undefined;
  const env = extractEnv(flags);

  config = loadFromCLI({
    script,
    name: typeof flags.name === 'string' ? flags.name : undefined,
    instances,
    port,
    env,
  });

  name = config.name;

  log('start', `Starting "${name}" ...`);
  await sendCommand('start', { name, config }, { silent: true });
  logSuccess(`"${name}" started`);
}
