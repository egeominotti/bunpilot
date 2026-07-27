// ---------------------------------------------------------------------------
// bunpilot – shared test temp-directory helper
// ---------------------------------------------------------------------------
//
// Tests must not hardcode `/private/tmp`. On macOS `/tmp` is a symlink to
// `/private/tmp`, so the literal works there; on Linux the path simply does not
// exist and every `mkdtempSync('/private/tmp/…')` dies with ENOENT — at module
// scope, which takes the whole file down and can leave a sibling file's `cwd`
// pointing at a directory that was never created.
//
// A SHORT base still matters: several suites put a unix control socket inside
// the temp dir, and `sockaddr_un.sun_path` is capped at 104 bytes on macOS
// (108 on Linux). `$TMPDIR` on macOS is a long per-user path under
// `/var/folders/...`, so prefer `/private/tmp` when it really exists and fall
// back to the platform temp dir otherwise.
// ---------------------------------------------------------------------------

import { accessSync, constants, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Shortest WRITABLE temp root available on this platform. */
export const TMP_BASE: string = (() => {
  try {
    // Existence is not enough: an unwritable /private/tmp would throw EACCES
    // inside mkdtemp at module scope, which is the same whole-file collapse
    // this helper exists to prevent.
    accessSync('/private/tmp', constants.W_OK);
    return '/private/tmp';
  } catch {
    return tmpdir();
  }
})();

/**
 * Create a unique temp directory under {@link TMP_BASE}.
 *
 * `prefix` is the same string you would have passed to `mkdtempSync`, minus the
 * directory part — e.g. `makeTempDir('bunpilot-h7-')`.
 */
export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(TMP_BASE, prefix));
}
