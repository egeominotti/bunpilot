// ---------------------------------------------------------------------------
// bunpilot – Cluster Strategy Detection
// ---------------------------------------------------------------------------

import type { ClusterStrategy } from '../config/types';

// ---------------------------------------------------------------------------
// Resolved Strategy (no 'auto')
// ---------------------------------------------------------------------------

export type ResolvedClusterStrategy = 'reusePort' | 'proxy';

// ---------------------------------------------------------------------------
// Platform Helpers
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the OS kernel supports `SO_REUSEPORT` load balancing.
 * Currently this is only Linux; macOS has the socket option but doesn't
 * distribute connections across listeners the same way.
 */
export function isReusePortSupported(): boolean {
  return process.platform === 'linux';
}

/**
 * Resolves a user-supplied (or default) `ClusterStrategy` into a concrete
 * strategy that the cluster layer can act on.
 *
 * - `'reusePort'` / `'proxy'` are returned as-is.
 * - `'auto'` picks `'reusePort'` on Linux and `'proxy'` everywhere else.
 */
export function detectStrategy(configured: ClusterStrategy): ResolvedClusterStrategy {
  if (configured === 'reusePort') return 'reusePort';
  if (configured === 'proxy') return 'proxy';

  // 'auto' – let the platform decide
  return isReusePortSupported() ? 'reusePort' : 'proxy';
}
