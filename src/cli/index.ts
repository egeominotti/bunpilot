// ---------------------------------------------------------------------------
// bunpilot – CLI Argument Parser
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  command: string;
  args: string[];
  flags: Record<string, string | boolean>;
}

// ---------------------------------------------------------------------------
// Flag definitions
// ---------------------------------------------------------------------------

/** Flags that accept a value (--flag value or --flag=value) */
const VALUE_FLAGS: Record<string, string> = {
  '--instances': 'instances',
  '-i': 'instances',
  '--port': 'port',
  '-p': 'port',
  '--name': 'name',
  '-n': 'name',
  '--env': 'env',
  '--config': 'config',
  '--lines': 'lines',
};

/** Boolean flags (presence means true) */
const BOOLEAN_FLAGS: Record<string, string> = {
  '--daemon': 'daemon',
  '--no-daemon': 'no-daemon',
  '--force': 'force',
  '--json': 'json',
  '--prometheus': 'prometheus',
  '--help': 'help',
  '-h': 'help',
  '--version': 'version',
  '-v': 'version',
};

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse raw argv into a structured `ParsedArgs`.
 *
 * Expects the standard Bun/Node layout:
 *   argv[0] = runtime path  (e.g. `/usr/local/bin/bun`)
 *   argv[1] = script path   (e.g. `./bunpilot`)
 *   argv[2+] = user args
 */
export function parseArgs(argv: string[]): ParsedArgs {
  // Skip the runtime and script entries
  const raw = argv.slice(2);

  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let command = '';

  let i = 0;
  while (i < raw.length) {
    const token = raw[i];

    // ---- Handle --flag=value syntax ----
    if (token.startsWith('--') && token.includes('=')) {
      const eqIdx = token.indexOf('=');
      const key = token.slice(0, eqIdx);
      const value = token.slice(eqIdx + 1);

      if (key in VALUE_FLAGS) {
        addFlag(flags, VALUE_FLAGS[key], value);
      } else {
        // Unknown flag — store by stripped key
        addFlag(flags, stripDashes(key), value);
      }
      i++;
      continue;
    }

    // ---- Boolean flags ----
    if (token in BOOLEAN_FLAGS) {
      flags[BOOLEAN_FLAGS[token]] = true;
      i++;
      continue;
    }

    // ---- Value flags ----
    if (token in VALUE_FLAGS) {
      const flagName = VALUE_FLAGS[token];
      const next = raw[i + 1];

      if (next === undefined || next.startsWith('-')) {
        flags[flagName] = true;
        i++;
      } else {
        addFlag(flags, flagName, next);
        i += 2;
      }
      continue;
    }

    // ---- Unknown --flags ----
    if (token.startsWith('-')) {
      const next = raw[i + 1];
      const key = stripDashes(token);

      if (next !== undefined && !next.startsWith('-')) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i++;
      }
      continue;
    }

    // ---- Positional arguments ----
    if (command === '') {
      command = token;
    } else {
      positional.push(token);
    }
    i++;
  }

  return { command, args: positional, flags };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Handle the special `--env` flag which is repeatable and collects
 * KEY=VALUE pairs into a nested Record under `flags._env`.
 *
 * All other flags simply overwrite.
 */
function addFlag(flags: Record<string, string | boolean>, name: string, value: string): void {
  if (name === 'env') {
    // Collect env vars in a separate map stored as JSON
    const existing = flags._env ? JSON.parse(flags._env as string) : {};
    const eqIdx = value.indexOf('=');
    if (eqIdx > 0) {
      const k = value.slice(0, eqIdx);
      const v = value.slice(eqIdx + 1);
      existing[k] = v;
    }
    flags._env = JSON.stringify(existing);
    return;
  }
  flags[name] = value;
}

function stripDashes(flag: string): string {
  return flag.replace(/^-+/, '');
}

// ---------------------------------------------------------------------------
// Env extraction helper
// ---------------------------------------------------------------------------

/** Extract the collected env vars from parsed flags. */
export function extractEnv(
  flags: Record<string, string | boolean>,
): Record<string, string> | undefined {
  if (typeof flags._env !== 'string') return undefined;
  try {
    const parsed = JSON.parse(flags._env);
    return Object.keys(parsed).length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}
