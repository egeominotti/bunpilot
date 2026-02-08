// ---------------------------------------------------------------------------
// bunpm2 – CLI Command: init
// ---------------------------------------------------------------------------
//
// Generate an example bunpm2.config.ts in the current working directory.
// ---------------------------------------------------------------------------

import { join } from 'node:path';
import { logSuccess, logWarn } from '../format';

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

const CONFIG_TEMPLATE = `import type { Bunpm2Config } from 'bunpm2';

const config: Bunpm2Config = {
  apps: [
    {
      name: 'my-app',
      script: './src/index.ts',
      instances: 'max',
      port: 3000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};

export default config;
`;

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function initCommand(
  _args: string[],
  _flags: Record<string, string | boolean>,
): Promise<void> {
  const dest = join(process.cwd(), 'bunpm2.config.ts');

  // Guard against overwriting an existing config
  const file = Bun.file(dest);
  if (await file.exists()) {
    logWarn(`Config file already exists: ${dest}`);
    return;
  }

  await Bun.write(dest, CONFIG_TEMPLATE);
  logSuccess(`Created ${dest}`);
}
