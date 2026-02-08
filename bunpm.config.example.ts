// ---------------------------------------------------------------------------
// bunpm – Example Configuration
// ---------------------------------------------------------------------------
// Copy this file to `bunpm.config.ts` and adjust to your needs.
//
//   cp bunpm.config.example.ts bunpm.config.ts
//
// ---------------------------------------------------------------------------

import type { BunpmConfig } from './src/config/types';

const config: BunpmConfig = {
  // ---------------------------------------------------------------------------
  // Applications
  // ---------------------------------------------------------------------------
  apps: [
    // --- API Server -----------------------------------------------------------
    {
      name: 'api-server',
      script: './src/server.ts',

      // Number of worker processes. Use 'max' to match available CPU cores.
      instances: 2,

      // Base port – each instance receives PORT via env.
      port: 3000,

      // Additional environment variables forwarded to workers.
      env: {
        NODE_ENV: 'production',
        LOG_LEVEL: 'info',
      },

      // HTTP health check (bunpm pings each worker periodically).
      healthCheck: {
        enabled: true,
        path: '/health',
        interval: 10_000, // ms between checks
        timeout: 5_000, // max response time
        unhealthyThreshold: 3, // consecutive failures before restart
      },

      // Restart policy
      maxRestarts: 15, // total restarts allowed inside the window
      maxRestartWindow: 60_000, // window duration (ms)
      minUptime: 5_000, // process must live this long to reset crash counter

      // Exponential backoff between restart attempts
      backoff: {
        initial: 1_000,
        multiplier: 2,
        max: 30_000,
      },

      // Time to wait for the worker to call bunpmReady()
      readyTimeout: 10_000,

      // Graceful shutdown
      shutdownSignal: 'SIGTERM',
      killTimeout: 8_000, // force-kill after this many ms

      // Log file rotation
      logs: {
        outFile: './logs/api-server-out.log',
        errFile: './logs/api-server-err.log',
        maxSize: 10 * 1024 * 1024, // 10 MB
        maxFiles: 5,
      },

      // Metrics collection
      metrics: {
        enabled: true,
        prometheus: false,
        collectInterval: 5_000,
      },

      // Clustering strategy: 'reusePort' (default), 'proxy', or 'auto'
      clustering: {
        enabled: true,
        strategy: 'reusePort',
        rollingRestart: {
          batchSize: 1, // restart one worker at a time
          batchDelay: 2_000, // wait between batches
        },
      },
    },

    // --- Background Worker ----------------------------------------------------
    {
      name: 'worker-service',
      script: './src/worker.ts',
      instances: 1,

      env: {
        NODE_ENV: 'production',
      },

      maxRestarts: 10,
      maxRestartWindow: 60_000,
      minUptime: 3_000,

      backoff: {
        initial: 500,
        multiplier: 1.5,
        max: 15_000,
      },

      readyTimeout: 30_000, // workers may need longer init
      shutdownSignal: 'SIGTERM',
      killTimeout: 10_000,
    },
  ],

  // ---------------------------------------------------------------------------
  // Daemon settings (optional)
  // ---------------------------------------------------------------------------
  daemon: {
    pidFile: './bunpm.pid',
    socketFile: './bunpm.sock',
    logFile: './logs/bunpm-daemon.log',
  },
};

export default config;
