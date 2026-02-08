# bunpm - Design Document

## Bun-Native Process Manager

**Single-binary, zero-dependency process manager costruito su Bun.**
**Scritto al 100% con API native Bun. Zero dipendenze npm.**
**Posizionamento: "PM2 per l'ecosistema Bun"**

---

## 1. Visione

bunpm e' un process manager nativo per Bun che fornisce:

- **Clustering** con port sharing e load balancing automatico
- **Crash recovery** con exponential backoff e restart intelligente
- **Zero-downtime reload** con rolling restart
- **Health checks** a due livelli (IPC heartbeat + HTTP probe)
- **Metriche built-in** con export Prometheus
- **Log management** con cattura e rotazione automatica
- **Stato persistente** su SQLite (sopravvive a restart del daemon)

**Perche' bunpm esiste:**

| Problema | Stato attuale | bunpm |
|----------|--------------|-------|
| `node:cluster` in Bun | Parziale, no handle passing | Non lo usa. Bun.spawn() + reusePort |
| PM2 con Bun | Cluster mode rotto | Nativo, zero hack |
| Scaling multi-core | Nessuna soluzione | `bunpm start -i max` |
| Zero-downtime deploy | Manuale | `bunpm reload` |
| Process monitoring | Niente di Bun-native | `bunpm monit` con metriche real-time |

**Quick start - 30 secondi:**

```bash
# Installa
bun add -g bunpm

# Avvia la tua app su tutti i core
bunpm start server.ts -i max --port 3000

# Vedi lo stato
bunpm ls

# Zero-downtime reload dopo un deploy
bunpm reload api

# Dashboard real-time
bunpm monit
```

**Config file - 5 righe per partire:**

```typescript
// bunpm.config.ts
export default {
  apps: [{
    name: 'api',
    script: 'src/server.ts',
    instances: 'max',
    port: 3000,
  }]
};
```

**Confronto con PM2 - stessa app, meno overhead:**

```bash
# PM2 (non funziona con Bun cluster mode)
pm2 start server.js -i max
# Errore: cluster.fork() non supportato / comportamento imprevedibile

# bunpm (nativo Bun)
bunpm start server.ts -i max --port 3000
# Funziona. reusePort su Linux, TCP proxy su macOS.
```

---

## 2. Confronto Architetturale

### 2.1 Cosa prendiamo da PM2

| Concetto PM2 | bunpm | Note |
|--------------|-------|------|
| Cluster mode (N istanze) | Si | Via reusePort (non node:cluster) |
| Auto-restart on crash | Si | Con exponential backoff |
| Zero-downtime reload | Si | Rolling restart, 1 worker alla volta |
| Daemon mode | Si | Opzionale, foreground di default |
| Log management | Si | Cattura + rotazione per dimensione |
| Process list (pm2 ls) | Si | `bunpm ls` con tabella formattata |
| Monit (pm2 monit) | Si | TUI con CPU, memory, restarts |
| Ecosystem config file | Si | `bunpm.config.ts` (TypeScript-first) |
| Startup scripts | Si | systemd, launchd |
| Graceful shutdown | Si | SIGTERM + timeout + SIGKILL |
| Environment variables | Si | Per-app env in config |
| Watch & restart | No (v1) | Solo production, no dev tooling |
| Deploy system | No | Fuori scope |
| PM2 Plus (cloud) | No | Fuori scope |

### 2.2 Cosa prendiamo da systemd

| Concetto systemd | bunpm | Note |
|------------------|-------|------|
| Service supervision | Si | Master monitora worker |
| Restart policies | Si | always, on-failure, never |
| Restart backoff | Si | Exponential con cap |
| Resource limits | Parziale | Solo memory limit (max_memory_restart) |
| Journal (log) | Si | Log per-worker con rotazione |
| Socket activation | No | Fuori scope |
| Dependencies | No | Un processo = un'app, niente DAG |

### 2.3 Cosa prendiamo da Docker/K8s

| Concetto Docker/K8s | bunpm | Note |
|---------------------|-------|------|
| Health checks | Si | HTTP + IPC, configurabili |
| Readiness probes | Si | Worker IPC "ready" signal |
| Liveness probes | Si | Heartbeat + HTTP health |
| Graceful shutdown | Si | SIGTERM con grace period |
| Rolling updates | Si | `bunpm reload` = rolling restart |
| Foreground process | Si | Default mode (PID 1 friendly) |
| Resource monitoring | Si | CPU, memory per worker |

---

## 3. Bun-Native: Zero dipendenze npm

bunpm usa **esclusivamente** le API native di Bun. Nessun pacchetto npm.

**API Bun utilizzate:**

| Funzionalita' | API Bun Nativa | Alternativa npm (NON usata) |
|---------------|----------------|----------------------------|
| Process spawn | `Bun.spawn()` | child_process, execa |
| IPC | `Bun.spawn({ ipc })` | node:cluster |
| TCP Proxy | `Bun.listen()` + `Bun.connect()` | http-proxy, net |
| HTTP Health | `fetch()` (built-in) | axios, node-fetch |
| HTTP Metrics | `Bun.serve()` | express, fastify |
| SQLite State | `bun:sqlite` (built-in) | better-sqlite3 |
| File I/O | `Bun.file()`, `Bun.write()` | fs, node:fs |
| Unix Socket | `Bun.listen({ unix })` | net.createServer |
| Signal Handling | `process.on('SIGTERM')` | - |
| Hashing | `Bun.hash()` | crypto |
| Test | `bun:test` | jest, vitest |
| Bundling | `Bun.build()` | esbuild, webpack |

**Principi di codice:**

- **Clean Code** - Nomi chiari, funzioni corte (<30 righe), singola responsabilita'
- **DRY** - Ogni logica esiste in un solo posto. Mai duplicare codice: estrarre in funzioni/moduli condivisi
- **File max 300-350 righe** - Nessun file sorgente deve superare 300-350 righe. Se un file cresce oltre questo limite, va suddiviso in moduli piu' piccoli e coesi
- **Interfacce chiare** - Ogni modulo espone un'interfaccia minima
- **Composizione > ereditarieta'** - Solo composizione di moduli
- **Fail fast** - Errori chiari al primo punto di fallimento

**Perche' Bun-native:**

1. **Bun.spawn() e' 60% piu' veloce** di Node child_process.spawn() - usa posix_spawn(3)
2. **bun:sqlite** e' 3-6x piu' veloce di better-sqlite3 - compilato nel runtime
3. **IPC "advanced"** usa JSC serialize - piu' veloce di JSON.stringify
4. **reusePort** nativo in `Bun.serve()` - zero overhead, kernel load balancing
5. **Single binary** - `bun build --compile` produce un eseguibile standalone
6. **Zero `node_modules`** - il binario e' self-contained

---

## 4. Architettura

### 4.1 Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                        bunpm CLI                                      │
│                                                                       │
│  bunpm start app.ts -i 4 --port 3000                                 │
│  bunpm ls                                                             │
│  bunpm reload api                                                     │
│  bunpm monit                                                          │
│  bunpm logs api                                                       │
│                                                                       │
│  ┌────────────────────────────────────────────────────────────┐       │
│  │  ControlClient (Unix socket, NDJSON)                       │       │
│  └──────────────────────┬─────────────────────────────────────┘       │
└─────────────────────────┼─────────────────────────────────────────────┘
                          │ ~/.bunpm/bunpm.sock
┌─────────────────────────┼─────────────────────────────────────────────┐
│                         ▼    MASTER PROCESS                           │
│  ┌───────────────────────────────────────────────────────────────┐    │
│  │                     ControlServer                              │    │
│  │  Unix socket → NDJSON → command dispatch                      │    │
│  └──────────────────────┬────────────────────────────────────────┘    │
│                         │                                             │
│  ┌──────────────────────▼────────────────────────────────────────┐    │
│  │                     Master Orchestrator                        │    │
│  │  - coordina tutti i componenti                                │    │
│  │  - gestisce il lifecycle di ogni app                          │    │
│  └───┬──────────┬──────────┬──────────┬──────────┬───────────────┘    │
│      │          │          │          │          │                     │
│  ┌───▼────┐ ┌──▼───┐ ┌───▼────┐ ┌───▼────┐ ┌──▼──────┐             │
│  │Process │ │Health│ │Metrics │ │  Log   │ │ Config  │             │
│  │Manager │ │Check │ │Aggreg. │ │Manager │ │ Loader  │             │
│  │        │ │      │ │        │ │        │ │         │             │
│  │-spawn  │ │-HTTP │ │-CPU %  │ │-capture│ │-.ts/.json│             │
│  │-kill   │ │-IPC  │ │-memory │ │-rotate │ │-validate│             │
│  │-restart│ │-heart│ │-prometh│ │-stream │ │-defaults│             │
│  │-reload │ │ beat │ │-sqlite │ │        │ │         │             │
│  └───┬────┘ └──────┘ └────────┘ └────────┘ └─────────┘             │
│      │                    │                                           │
│  ┌───▼────────────────────▼──────────────────────────────────────┐    │
│  │  ClusterManager                                                │    │
│  │  Linux: reusePort (kernel LB, zero overhead)                  │    │
│  │  macOS: TCP proxy (master accept → round-robin → workers)     │    │
│  └───┬───────────────────────────────────────────────────────────┘    │
│      │                                                                │
│  ┌───▼────────────────────────────────────────────────────────────┐   │
│  │  SQLiteStore (~/.bunpm/bunpm.db, WAL mode)                     │   │
│  │  - apps: registry                                              │   │
│  │  - workers: stato corrente                                     │   │
│  │  - restart_history: crash log                                  │   │
│  │  - metric_snapshots: storico metriche                          │   │
│  └────────────────────────────────────────────────────────────────┘   │
│      │                                                                │
│      │ IPC (JSC serialize, "advanced" mode)                          │
│      │                                                                │
└──────┼────────────────────────────────────────────────────────────────┘
       │
       ├──────────────────┬──────────────────┐
       │                  │                  │
  ┌────▼─────┐      ┌────▼─────┐      ┌────▼─────┐
  │ Worker 0 │      │ Worker 1 │      │ Worker N │
  │ (Bun.    │      │ (Bun.    │      │ (Bun.    │
  │  spawn)  │      │  spawn)  │      │  spawn)  │
  │          │      │          │      │          │
  │ user app │      │ user app │      │ user app │
  │ :3000    │      │ :3000    │      │ :3000    │
  │ reusePort│      │ reusePort│      │ reusePort│
  └──────────┘      └──────────┘      └──────────┘
```

### 4.2 Principio fondamentale

**Il master process non esegue MAI codice utente.** E' puramente un supervisore. I worker sono processi OS separati (Bun.spawn). Se un worker crasha (segfault, OOM, uncaught exception), il master e' completamente inalterato.

### 4.3 Due modalita' di esecuzione

**Foreground (default, Docker-friendly):**
- bunpm e' il processo in primo piano (PID 1 in Docker)
- stdout/stderr dei worker multiplexati con prefissi
- SIGTERM/SIGINT → graceful shutdown di tutti i worker
- SIGHUP → reload (zero-downtime restart)
- Control socket comunque attivo (CLI puo' connettersi)

**Daemon (opzionale, bare metal):**
- bunpm si stacca dal terminale
- PID file in `~/.bunpm/bunpm.pid`
- Log del master in `~/.bunpm/bunpm-daemon.log`
- CLI comunica via Unix socket
- `bunpm daemon start` / `bunpm daemon stop`

---

## 5. Worker Lifecycle

### 5.1 State Machine

```
                  Bun.spawn()
                      │
                      ▼
               ┌────────────┐
               │  SPAWNING   │  processo in avvio, PID assegnato
               └──────┬─────┘
                      │  processo attivo
                      ▼
               ┌────────────┐
               │  STARTING   │  in attesa di IPC "ready" o health check
               └──────┬─────┘
                    ╱     ╲
   readyTimeout   ╱       ╲  IPC "ready" / health OK
   superato      ╱         ╲
               ▼             ▼
       ┌─────────┐    ┌─────────┐
       │ ERRORED  │    │ ONLINE   │  ← sta servendo traffico
       └─────────┘    └────┬────┘
                           │
              reload /     │  shutdown / SIGTERM
              restart      │
                           ▼
               ┌────────────┐
               │  DRAINING   │  finisce richieste in-flight
               └──────┬─────┘
                      │  drain completato / timeout
                      ▼
               ┌────────────┐
               │  STOPPING   │  SIGTERM inviato, attesa exit
               └──────┬─────┘
                    ╱     ╲
    killTimeout   ╱       ╲  process.exited
    (SIGKILL)    ╱         ╲
               ▼             ▼
       ┌─────────┐    ┌─────────┐
       │ CRASHED  │    │ STOPPED  │
       └────┬────┘    └─────────┘
            │
            │  backoff timer
            │  scaduto
            ▼
       ┌────────────┐      maxRestarts
       │  SPAWNING   │ ──────────────→ ERRORED
       └────────────┘      superato
```

### 5.2 Transizioni valide

```typescript
const TRANSITIONS: Record<WorkerState, WorkerState[]> = {
  spawning:  ['starting', 'crashed'],
  starting:  ['online', 'errored', 'crashed'],
  online:    ['draining', 'crashed'],
  draining:  ['stopping', 'crashed'],
  stopping:  ['stopped', 'crashed'],
  stopped:   ['spawning'],          // restart manuale
  crashed:   ['spawning', 'errored'], // auto-restart o give up
  errored:   ['spawning'],          // solo restart --force
};
```

### 5.3 Tipi

```typescript
type WorkerState =
  | 'spawning'    // Bun.spawn() chiamato, processo in avvio
  | 'starting'    // Processo attivo, attesa "ready"
  | 'online'      // Worker pronto, serve traffico
  | 'draining'    // Shutdown graceful, no nuove connessioni
  | 'stopping'    // SIGTERM inviato, attesa exit
  | 'stopped'     // Uscito pulito (exit code 0)
  | 'errored'     // Troppi crash, rinuncia
  | 'crashed';    // Uscito anomalo, verra' riavviato

interface WorkerInfo {
  id: number;                    // 0-based index nel gruppo
  pid: number;                   // OS process ID
  state: WorkerState;
  startedAt: number;             // timestamp epoch ms
  readyAt: number | null;        // quando ha inviato "ready"
  restartCount: number;          // restart totali per questo slot
  consecutiveCrashes: number;    // si resetta dopo run stabile
  lastCrashAt: number | null;
  exitCode: number | null;
  signalCode: string | null;
  memory: MemoryMetrics | null;
  cpu: CpuMetrics | null;
}

interface MemoryMetrics {
  rss: number;          // bytes
  heapTotal: number;
  heapUsed: number;
  external: number;
  timestamp: number;
}

interface CpuMetrics {
  user: number;         // microseconds
  system: number;
  percentage: number;   // calcolato dal master tramite delta
  timestamp: number;
}
```

---

## 6. IPC Protocol (Master ↔ Worker)

### 6.1 Formato

Tutti i messaggi IPC usano la serializzazione "advanced" di Bun (JSC structured clone). Ogni messaggio ha un campo `type` discriminatore.

### 6.2 Messaggi Worker → Master

```typescript
type WorkerMessage =
  | { type: 'ready' }
  | { type: 'metrics'; payload: WorkerMetricsPayload }
  | { type: 'heartbeat'; uptime: number }
  | { type: 'custom'; channel: string; data: unknown };

interface WorkerMetricsPayload {
  memory: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
  };
  cpu: {
    user: number;
    system: number;
  };
  eventLoopLag?: number;        // ms
  activeHandles?: number;
  activeRequests?: number;
  custom?: Record<string, number>;  // contatori user-defined
}
```

### 6.3 Messaggi Master → Worker

```typescript
type MasterMessage =
  | { type: 'shutdown'; timeout: number }      // shutdown graceful
  | { type: 'ping' }                           // health check IPC
  | { type: 'collect-metrics' }                // richiedi metriche adesso
  | { type: 'config-update'; config: Partial<AppConfig> };
```

### 6.4 Worker SDK (opzionale)

Un piccolo helper che i worker possono importare per integrarsi con bunpm:

```typescript
// import { bunpmReady, bunpmOnShutdown } from 'bunpm/worker'

/** Segnala al master che il worker e' pronto */
export function bunpmReady(): void {
  if (typeof process.send === 'function') {
    process.send({ type: 'ready' });
  }
}

/** Registra handler per graceful shutdown */
export function bunpmOnShutdown(handler: () => Promise<void> | void): void {
  process.on('message', async (msg: any) => {
    if (msg?.type === 'shutdown') {
      await handler();
      process.exit(0);
    }
  });
}

/** Avvia reporter automatico delle metriche (ogni collectInterval) */
export function bunpmStartMetrics(interval: number = 5000): void {
  setInterval(() => {
    if (typeof process.send === 'function') {
      process.send({
        type: 'metrics',
        payload: {
          memory: process.memoryUsage(),
          cpu: process.cpuUsage(),
        },
      });
    }
  }, interval);
}
```

**NOTA:** L'SDK e' opzionale. bunpm funziona anche senza. Se il worker non invia `ready` via IPC, il master usa il fallback HTTP health check.

### 6.5 Esempio: app integrata con bunpm SDK

```typescript
// src/server.ts
import { bunpmReady, bunpmOnShutdown, bunpmStartMetrics } from 'bunpm/worker';

const server = Bun.serve({
  port: Number(process.env.BUNPM_PORT) || 3000,
  reusePort: process.env.BUNPM_REUSE_PORT === '1',
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/health') return new Response('ok');
    return new Response('Hello from bunpm!');
  },
});

// Segnala al master che siamo pronti
bunpmReady();

// Avvia reporter metriche ogni 5s
bunpmStartMetrics();

// Gestisci shutdown graceful
bunpmOnShutdown(async () => {
  server.stop();
  // chiudi connessioni DB, flush buffer, ecc.
});

console.log(`Worker ${process.env.BUNPM_WORKER_ID} listening on :${server.port}`);
```

### 6.6 Esempio: app SENZA SDK (funziona comunque)

```typescript
// src/server.ts - nessun import da bunpm
const server = Bun.serve({
  port: 3000,
  fetch(req) {
    if (new URL(req.url).pathname === '/health') return new Response('ok');
    return new Response('Hello!');
  },
});
```

bunpm rileva che il worker non invia `ready` via IPC e usa il fallback:
1. Attende `readyTimeout` (30s default) per IPC "ready"
2. Se non arriva, prova HTTP GET su `http://127.0.0.1:{port}/health`
3. Se HTTP risponde 2xx/3xx, il worker e' considerato online
4. Se ne' IPC ne' HTTP rispondono entro il timeout → worker errored

---

## 7. CLI Commands

### 7.1 Panoramica

```
bunpm <command> [options]

Gestione processi:
  bunpm start [config|script] [opts]    Avvia app da config o script singolo
  bunpm stop <app|all>                  Stop graceful
  bunpm restart <app|all>               Hard restart (stop + start)
  bunpm reload <app|all>                Zero-downtime rolling restart
  bunpm delete <app|all>                Stop e rimuovi dal registry

Monitoraggio:
  bunpm list | bunpm ls                 Lista processi gestiti
  bunpm status <app>                    Stato dettagliato di un'app
  bunpm monit                           Dashboard real-time (TUI)
  bunpm logs <app> [--lines N]          Stream log (follow mode)

Metriche:
  bunpm metrics <app>                   Mostra metriche correnti
  bunpm metrics <app> --json            Output JSON per scripting
  bunpm metrics <app> --prometheus      Output Prometheus format

Daemon:
  bunpm daemon start                    Avvia daemon in background
  bunpm daemon stop                     Ferma daemon
  bunpm daemon status                   Controlla se daemon e' attivo

Utility:
  bunpm ping                            Verifica connettivita' al daemon
  bunpm dump                            Dump stato completo (debug)
  bunpm init                            Genera bunpm.config.ts di esempio
  bunpm startup                         Genera script startup OS
```

### 7.2 `bunpm start`

```bash
# Da config file
bunpm start                             # cerca bunpm.config.ts nella dir corrente
bunpm start bunpm.config.ts             # config esplicito
bunpm start --config ./custom.config.ts

# Da script singolo (senza config file)
bunpm start server.ts                   # 1 istanza, nessun clustering
bunpm start server.ts -i 4             # 4 istanze
bunpm start server.ts -i max           # 1 per CPU core
bunpm start server.ts -i max --port 3000  # con clustering su porta 3000
bunpm start server.ts --name api       # nome custom

# Opzioni
--instances, -i <N|max>                 # numero worker (default: 1)
--port, -p <port>                       # porta per clustering
--name, -n <name>                       # nome app (default: nome file)
--no-daemon                             # foreground mode (default)
--daemon                                # daemon mode
--env KEY=VALUE                         # variabile d'ambiente (ripetibile)
--max-memory <size>                     # es: "500M", "1G"
```

### 7.3 `bunpm ls` - Output

```
$ bunpm ls
┌──────────┬────┬───────┬────────┬───────┬──────────┬──────────┬──────────┐
│ App      │ id │ pid   │ state  │ cpu   │ memory   │ uptime   │ restarts │
├──────────┼────┼───────┼────────┼───────┼──────────┼──────────┼──────────┤
│ api      │ 0  │ 12340 │ online │ 2.1%  │ 45.2 MB  │ 2h 15m   │ 0        │
│ api      │ 1  │ 12341 │ online │ 1.8%  │ 43.1 MB  │ 2h 15m   │ 0        │
│ api      │ 2  │ 12342 │ online │ 2.3%  │ 44.8 MB  │ 2h 15m   │ 1        │
│ api      │ 3  │ 12343 │ online │ 1.5%  │ 42.9 MB  │ 2h 15m   │ 0        │
│ worker   │ 0  │ 12344 │ online │ 5.2%  │ 67.3 MB  │ 2h 15m   │ 0        │
│ worker   │ 1  │ 12345 │ online │ 4.8%  │ 65.1 MB  │ 2h 15m   │ 0        │
└──────────┴────┴───────┴────────┴───────┴──────────┴──────────┴──────────┘
```

### 7.4 `bunpm reload` - Output

```
$ bunpm reload api
[bunpm] Rolling restart di "api" (4 worker, batch=1)
[bunpm] api:0 │ spawning sostituto...
[bunpm] api:0 │ nuovo worker pid 12350 online
[bunpm] api:0 │ draining vecchio worker pid 12340...
[bunpm] api:0 │ vecchio worker fermato
[bunpm] api:1 │ spawning sostituto...
[bunpm] api:1 │ nuovo worker pid 12351 online
[bunpm] api:1 │ draining vecchio worker pid 12341...
[bunpm] api:1 │ vecchio worker fermato
[bunpm] api:2 │ spawning sostituto...
[bunpm] api:2 │ nuovo worker pid 12352 online
[bunpm] api:2 │ draining vecchio worker pid 12342...
[bunpm] api:2 │ vecchio worker fermato
[bunpm] api:3 │ spawning sostituto...
[bunpm] api:3 │ nuovo worker pid 12353 online
[bunpm] api:3 │ draining vecchio worker pid 12343...
[bunpm] api:3 │ vecchio worker fermato
[bunpm] Reload completato. 0 errori.
```

---

## 8. Config File

### 8.1 Formato

`bunpm.config.ts` (primario) con fallback a `bunpm.config.js` e `bunpm.json`.

**Precedenza:**
```
CLI flags  >  Environment variables  >  Config file  >  Defaults
```

### 8.2 Config minimale

```typescript
// bunpm.config.ts
import type { BunpmConfig } from 'bunpm';

export default {
  apps: [{
    name: 'api',
    script: 'src/server.ts',
    instances: 'max',
    port: 3000,
  }],
} satisfies BunpmConfig;
```

### 8.3 Config completo

```typescript
import type { BunpmConfig } from 'bunpm';

export default {
  apps: [
    {
      name: 'api',
      script: 'src/server.ts',
      instances: 4,
      port: 3000,
      cwd: '/app',
      interpreter: 'bun',
      env: {
        NODE_ENV: 'production',
        DB_URL: 'postgres://localhost/mydb',
      },

      // Health check
      healthCheck: {
        enabled: true,
        path: '/health',
        interval: 30_000,        // ogni 30s
        timeout: 5_000,          // 5s per rispondere
        unhealthyThreshold: 3,   // 3 fallimenti consecutivi
      },

      // Crash recovery
      maxRestarts: 15,
      maxRestartWindow: 900_000,  // 15 minuti
      minUptime: 30_000,          // 30s = run stabile
      backoff: {
        initial: 1_000,           // 1s primo retry
        multiplier: 2,
        max: 30_000,              // 30s cap
      },

      // Graceful shutdown
      killTimeout: 5_000,
      shutdownSignal: 'SIGTERM',
      readyTimeout: 30_000,

      // Log
      logs: {
        maxSize: 10 * 1024 * 1024,  // 10MB
        maxFiles: 5,
      },

      // Metriche
      metrics: {
        enabled: true,
        httpPort: 9615,
        prometheus: true,
        collectInterval: 5_000,
      },

      // Clustering
      clustering: {
        enabled: true,
        strategy: 'auto',            // auto | reusePort | proxy
        rollingRestart: {
          batchSize: 1,               // 1 worker alla volta
          batchDelay: 1_000,          // 1s tra batch
        },
      },
    },
    {
      name: 'queue-worker',
      script: 'src/queue-worker.ts',
      instances: 2,
      // Nessuna porta - non e' un HTTP server
      maxRestarts: 10,
      maxRestartWindow: 600_000,
      minUptime: 10_000,
      backoff: { initial: 2_000, multiplier: 2, max: 60_000 },
      killTimeout: 30_000,  // queue worker ha bisogno di piu' tempo per drain
    },
  ],

  daemon: {
    pidFile: '~/.bunpm/bunpm.pid',
    socketFile: '~/.bunpm/bunpm.sock',
    logFile: '~/.bunpm/bunpm-daemon.log',
  },
} satisfies BunpmConfig;
```

### 8.4 Interfaccia TypeScript completa

```typescript
interface AppConfig {
  /** Nome dell'applicazione (unico) */
  name: string;

  /** Entry point (es. "src/server.ts") */
  script: string;

  /** Numero worker ("max" = CPU cores) */
  instances: number | 'max';

  /** Porta pubblica per clustering */
  port?: number;

  /** Environment variables extra per worker */
  env?: Record<string, string>;

  /** Working directory */
  cwd?: string;

  /** Interprete (default: "bun") */
  interpreter?: string;

  /** Health check HTTP */
  healthCheck?: {
    enabled: boolean;                    // default true
    path: string;                        // default "/health"
    interval: number;                    // ms, default 30000
    timeout: number;                     // ms, default 5000
    unhealthyThreshold: number;          // default 3
  };

  /** Crash recovery */
  maxRestarts: number;                   // default 15
  maxRestartWindow: number;              // ms, default 900000
  minUptime: number;                     // ms, default 30000
  backoff: {
    initial: number;                     // ms, default 1000
    multiplier: number;                  // default 2
    max: number;                         // ms, default 30000
  };

  /** Graceful shutdown */
  killTimeout: number;                   // ms, default 5000
  shutdownSignal: 'SIGTERM' | 'SIGINT';  // default "SIGTERM"
  readyTimeout: number;                  // ms, default 30000

  /** Log */
  logs?: {
    outFile?: string;
    errFile?: string;
    maxSize: number;                     // bytes, default 10MB
    maxFiles: number;                    // default 5
  };

  /** Metriche */
  metrics?: {
    enabled: boolean;                    // default true
    httpPort?: number;                   // default 9615
    prometheus: boolean;                 // default false
    collectInterval: number;             // ms, default 5000
  };

  /** Clustering */
  clustering?: {
    enabled: boolean;                    // default true quando instances > 1
    strategy: 'reusePort' | 'proxy' | 'auto';  // default "auto"
    rollingRestart: {
      batchSize: number;                 // default 1
      batchDelay: number;                // ms, default 1000
    };
  };
}

interface BunpmConfig {
  apps: AppConfig[];
  daemon?: {
    pidFile?: string;
    socketFile?: string;
    logFile?: string;
  };
}
```

### 8.5 Environment variables

```bash
BUNPM_HOME=~/.bunpm                    # directory base
BUNPM_SOCKET=~/.bunpm/bunpm.sock       # socket path
BUNPM_LOG_LEVEL=info                   # debug | info | warn | error
```

### 8.6 Variabili iniettate nei worker

bunpm inietta queste variabili d'ambiente in ogni worker:

```bash
BUNPM_WORKER_ID=0                      # 0-based index nel gruppo
BUNPM_PORT=3000                        # porta da usare
BUNPM_REUSE_PORT=1                     # "1" su Linux, "0" su macOS
BUNPM_APP_NAME=api                     # nome dell'app
BUNPM_INSTANCES=4                      # numero totale worker
```

---

## 9. Clustering

### 9.1 Strategia per piattaforma

```typescript
function detectStrategy(configured: 'reusePort' | 'proxy' | 'auto'): ClusterStrategy {
  if (configured === 'reusePort') return 'reusePort';
  if (configured === 'proxy') return 'proxy';
  // 'auto': reusePort su Linux, proxy altrove
  return process.platform === 'linux' ? 'reusePort' : 'proxy';
}
```

### 9.2 Linux: reusePort

Ogni worker fa `Bun.serve()` sulla stessa porta con `reusePort: true`. Il kernel Linux distribuisce le connessioni in modo bilanciato tra i processi.

```
Client :3000 ──→ Kernel (SO_REUSEPORT) ──→ Worker 0 :3000
                                       ──→ Worker 1 :3000
                                       ──→ Worker 2 :3000
                                       ──→ Worker 3 :3000
```

**Overhead: zero.** Nessun proxy, nessun hop extra. Il kernel fa tutto.

**Implementazione:** Il master spawna i worker con env `BUNPM_REUSE_PORT=1` e `BUNPM_PORT=3000`. L'app utente (o l'SDK) legge le env e passa `reusePort: true` a `Bun.serve()`.

### 9.3 macOS: TCP Proxy

macOS ignora `reusePort`. Il master avvia un TCP proxy sulla porta pubblica e distribuisce le connessioni in round-robin ai worker su porte interne.

```
Client :3000 ──→ Master proxy :3000 ──→ Worker 0 :40001
                                    ──→ Worker 1 :40002
                                    ──→ Worker 2 :40003
                                    ──→ Worker 3 :40004
```

**Overhead: ~50μs per connessione** (latenza del proxy hop). Trascurabile per development.

**Implementazione:**

```typescript
const INTERNAL_PORT_BASE = 40001;

class MasterProxy {
  private workers: { port: number; alive: boolean }[] = [];
  private currentIndex = 0;
  private server: ReturnType<typeof Bun.listen> | null = null;

  start(publicPort: number, workerCount: number): void {
    for (let i = 0; i < workerCount; i++) {
      this.workers.push({ port: INTERNAL_PORT_BASE + i, alive: false });
    }

    this.server = Bun.listen({
      hostname: '0.0.0.0',
      port: publicPort,
      socket: {
        open: (serverSocket) => {
          const target = this.nextAliveWorker();
          if (!target) {
            serverSocket.end();
            return;
          }
          // Connetti al worker e fai pipe bidirezionale
          Bun.connect({
            hostname: '127.0.0.1',
            port: target.port,
            socket: {
              data(clientSocket, data) {
                serverSocket.write(data);
              },
              close() { serverSocket.end(); },
              error() { serverSocket.end(); },
            },
          });
        },
        data: () => {},
        close: () => {},
        error: () => {},
      },
    });
  }

  private nextAliveWorker(): { port: number } | null {
    const alive = this.workers.filter(w => w.alive);
    if (alive.length === 0) return null;
    const worker = alive[this.currentIndex % alive.length];
    this.currentIndex++;
    return worker;
  }

  markAlive(workerIndex: number): void {
    this.workers[workerIndex].alive = true;
  }

  markDead(workerIndex: number): void {
    this.workers[workerIndex].alive = false;
  }
}
```

### 9.4 Worker senza porta (background worker)

Per app senza `port` (es. queue worker, cron job), il clustering non si applica. I worker vengono semplicemente spawnati come processi indipendenti senza port sharing.

---

## 10. Health Checks

### 10.1 Due livelli

**Livello 1 - IPC Heartbeat (processo vivo?):**

I worker inviano `{ type: 'heartbeat' }` ogni 10 secondi. Se il master non riceve heartbeat per 3 intervalli (30s), il worker e' considerato non responsivo.

Questo verifica: il processo esiste e l'event loop non e' bloccato.

**Livello 2 - HTTP Health (app funzionante?):**

Il master invia HTTP GET a `http://127.0.0.1:{port}{healthCheck.path}` ogni `healthCheck.interval` ms. Se la risposta non e' 2xx/3xx entro `healthCheck.timeout`, il check fallisce.

Questo verifica: l'app puo' effettivamente servire richieste.

### 10.2 Flusso

```
Worker avviato
  │
  ▼
Master attende IPC "ready" (readyTimeout = 30s)
  │
  ├── IPC "ready" ricevuto → stato = online, avvia health checks periodici
  │
  └── Timeout senza IPC "ready"
      │
      ├── HTTP health check OK → stato = online
      │
      └── HTTP health check fallito → stato = errored, restart
```

### 10.3 Health check periodico (worker online)

```
Ogni healthCheck.interval:
  │
  ├── HTTP GET /health → 200 OK
  │   └── failureCount = 0, tutto bene
  │
  └── HTTP GET /health → timeout / errore / 5xx
      │
      ├── failureCount++ < unhealthyThreshold
      │   └── warning, riprova al prossimo intervallo
      │
      └── failureCount >= unhealthyThreshold
          └── worker considerato unhealthy → kill + restart
```

### 10.4 Implementazione

```typescript
class HealthChecker {
  private failureCounts: Map<number, number> = new Map();
  private timers: Map<number, Timer> = new Map();

  startChecking(workerId: number, config: AppConfig): void {
    const hc = config.healthCheck!;

    const timer = setInterval(async () => {
      const healthy = await this.probe(workerId, config);

      if (!healthy) {
        const count = (this.failureCounts.get(workerId) ?? 0) + 1;
        this.failureCounts.set(workerId, count);

        if (count >= hc.unhealthyThreshold) {
          this.emit('unhealthy', workerId);
        }
      } else {
        this.failureCounts.set(workerId, 0);
      }
    }, hc.interval);

    this.timers.set(workerId, timer);
  }

  private async probe(workerId: number, config: AppConfig): Promise<boolean> {
    const hc = config.healthCheck!;
    const port = this.getWorkerPort(workerId, config);
    const url = `http://127.0.0.1:${port}${hc.path}`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), hc.timeout);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      return res.status >= 200 && res.status < 400;
    } catch {
      return false;
    }
  }

  stopChecking(workerId: number): void {
    const timer = this.timers.get(workerId);
    if (timer) clearInterval(timer);
    this.timers.delete(workerId);
    this.failureCounts.delete(workerId);
  }
}
```

---

## 11. Crash Recovery

### 11.1 Exponential Backoff

```
Crash #1:  restart dopo 1s
Crash #2:  restart dopo 2s
Crash #3:  restart dopo 4s
Crash #4:  restart dopo 8s
Crash #5:  restart dopo 16s
Crash #6:  restart dopo 30s  (cap raggiunto)
Crash #7:  restart dopo 30s
...
Crash #15: → stato ERRORED, nessun auto-restart
```

### 11.2 Regole

- **Backoff formula:** `delay = min(initial * multiplier^(crashes-1), max)`
- **Default:** `1s * 2^(n-1)`, cap a 30s
- **Window:** 15 restart in 15 minuti → stato errored
- **Reset:** se il worker resta attivo per `minUptime` (30s), il contatore crash si resetta
- **Force restart:** `bunpm restart --force <app>` riavvia anche worker in stato errored

### 11.3 Implementazione

```typescript
class CrashRecovery {
  private states: Map<number, BackoffState> = new Map();

  onWorkerCrash(workerId: number, config: AppConfig): 'restart' | 'give-up' {
    const state = this.getOrInit(workerId);
    const now = Date.now();

    // Finestra scaduta? Reset contatori
    if (now - state.windowStart > config.maxRestartWindow) {
      state.windowStart = now;
      state.restartsInWindow = 0;
    }

    state.restartsInWindow++;
    state.consecutiveCrashes++;
    state.totalRestarts++;
    state.lastCrashAt = now;

    // Troppi restart nella finestra?
    if (state.restartsInWindow >= config.maxRestarts) {
      return 'give-up';
    }

    // Calcola delay
    const delay = Math.min(
      config.backoff.initial * Math.pow(config.backoff.multiplier, state.consecutiveCrashes - 1),
      config.backoff.max
    );
    state.nextRestartAt = now + delay;

    return 'restart';
  }

  /** Worker stabile: resetta contatore crash */
  onWorkerStable(workerId: number): void {
    const state = this.states.get(workerId);
    if (state) state.consecutiveCrashes = 0;
  }

  /** Millisecondi da attendere prima del prossimo restart */
  getDelay(workerId: number): number {
    const state = this.states.get(workerId);
    if (!state) return 0;
    return Math.max(0, state.nextRestartAt - Date.now());
  }
}

interface BackoffState {
  consecutiveCrashes: number;
  lastCrashAt: number;
  nextRestartAt: number;
  totalRestarts: number;
  windowStart: number;
  restartsInWindow: number;
}
```

---

## 12. Zero-Downtime Reload

### 12.1 Algoritmo (rolling restart)

```
bunpm reload api
  │
  ▼
[1] Valida
    - App esiste e sta girando
    - Almeno 1 worker restera' online in ogni momento
    - Se instances=1, spawna temporaneamente un secondo worker prima
  │
  ▼
[2] Loop rolling restart (batchSize worker alla volta)

    PER ogni batch:

    a) Spawna NUOVI worker sostitutivi
       - Nuovi worker ricevono script/config aggiornati
       - Attendi IPC "ready" o health check OK

    b) Draina VECCHI worker
       - Invia { type: 'shutdown', timeout: killTimeout } via IPC
       - reusePort: vecchio worker smette di accettare nuove connessioni
       - proxy: master rimuove vecchio worker dal round-robin

    c) Attendi che VECCHI worker escano
       - Se non escono entro killTimeout: SIGKILL

    d) Attendi batchDelay prima del prossimo batch
  │
  ▼
[3] Verifica
    - Tutti i nuovi worker sono "online"
    - Health check passa
    - Aggiorna SQLite registry con nuovi PID
```

### 12.2 Timeline (4 worker, batchSize=1)

```
Tempo ──────────────────────────────────────────────────────►

Worker 0 (vecchio): [════ONLINE════][DRAIN][STOP]
Worker 0 (nuovo):              [SPAWN][READY][════ONLINE═══════════]
                                       ▲
                                       └── vecchio rimosso dopo che nuovo e' ready

Worker 1 (vecchio):                          [════ONLINE════][DRAIN][STOP]
Worker 1 (nuovo):                                       [SPAWN][READY][════ONLINE════]

Worker 2 (vecchio):                                                   [════ONLINE════][DRAIN][STOP]
Worker 2 (nuovo):                                                                [SPAWN][READY][══ONLINE══]

Worker 3 (vecchio):                                                                            [════ONLINE════][DRAIN][STOP]
Worker 3 (nuovo):                                                                                         [SPAWN][READY][══]
```

### 12.3 Caso speciale: singola istanza

```
Worker 0 (vecchio): [════ONLINE═══════════][DRAIN][STOP]
Worker 0 (nuovo):              [SPAWN][READY][════ONLINE════]
                                       ▲
                                       └── brevemente 2 worker attivi
```

Per `reusePort` su Linux, il kernel gestisce naturalmente la coesistenza. Per proxy mode su macOS, il master aggiunge il nuovo worker al pool prima di rimuovere il vecchio.

---

## 13. Log Management

### 13.1 Cattura

I worker sono spawnati con `stdout: 'pipe'` e `stderr: 'pipe'`. Il master legge da queste pipe e scrive nei file di log appropriati.

```typescript
const proc = Bun.spawn({
  cmd: ['bun', 'run', config.script],
  stdout: 'pipe',
  stderr: 'pipe',
  ipc(message) { /* gestisci IPC */ },
  env: workerEnv,
});

// Pipe stdout al log file
const outWriter = logManager.createWriter(config.name, workerId, 'out');
const reader = proc.stdout.getReader();

(async () => {
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    outWriter.write(value);
    // In foreground mode, scrivi anche su stdout del master con prefisso
    if (foregroundMode) {
      process.stdout.write(`[${config.name}:${workerId}] `);
      process.stdout.write(value);
    }
  }
})();
```

### 13.2 Rotazione

Rotazione per dimensione (non per tempo):

| Parametro | Default | Descrizione |
|-----------|---------|-------------|
| `maxSize` | 10 MB | Dimensione max per file log |
| `maxFiles` | 5 | Numero max file rotati |

```
Rotazione:
  api-0-out.log      → api-0-out.1.log   (rename)
  api-0-out.1.log    → api-0-out.2.log   (rename)
  api-0-out.2.log    → api-0-out.3.log   (rename)
  api-0-out.4.log    → eliminato          (maxFiles=5 raggiunto)
  api-0-out.log      → nuovo file vuoto   (creato)
```

### 13.3 Struttura directory

```
~/.bunpm/
  logs/
    api/
      api-0-out.log            # stdout corrente worker 0
      api-0-out.1.log          # rotato (precedente)
      api-0-out.2.log          # rotato (piu' vecchio)
      api-0-err.log            # stderr corrente worker 0
      api-1-out.log
      api-1-err.log
      ...
    queue-worker/
      queue-worker-0-out.log
      queue-worker-0-err.log
      ...
  bunpm-daemon.log             # log del master (daemon mode)
```

---

## 14. Metrics & Monitoring

### 14.1 Raccolta

```
Worker Process                    Master Process                  Consumer
┌──────────────────┐             ┌─────────────────────┐         ┌─────────────┐
│ setInterval(5s)  │ ──IPC───→  │ MetricsAggregator    │ ──HTTP→ │ Prometheus  │
│ process.memory() │             │ - per-worker store   │         │ Grafana     │
│ process.cpu()    │             │ - CPU % calculation  │         │ curl        │
│ custom counters  │             │ - SQLite persistence │         └─────────────┘
└──────────────────┘             └─────────────────────┘
```

### 14.2 Calcolo CPU %

```typescript
class MetricsAggregator {
  private previousCpu: Map<number, { user: number; system: number; time: number }> = new Map();

  calculateCpuPercent(workerId: number, current: { user: number; system: number }): number {
    const prev = this.previousCpu.get(workerId);
    if (!prev) {
      this.previousCpu.set(workerId, { ...current, time: Date.now() });
      return 0;
    }

    const elapsedMs = Date.now() - prev.time;
    const userDelta = (current.user - prev.user) / 1000;   // μs → ms
    const systemDelta = (current.system - prev.system) / 1000;
    const cpuMs = userDelta + systemDelta;
    const percent = (cpuMs / elapsedMs) * 100;

    this.previousCpu.set(workerId, { ...current, time: Date.now() });
    return Math.round(percent * 10) / 10;
  }
}
```

### 14.3 HTTP Metrics API

Il master espone metriche su porta configurabile (default 9615):

```
GET /metrics              → formato Prometheus (se abilitato)
GET /api/metrics          → JSON
GET /api/metrics/:app     → metriche per-app
GET /api/status           → stato completo di tutte le app
```

### 14.4 Prometheus Format

```
# HELP bunpm_worker_memory_rss_bytes Worker RSS memory in bytes
# TYPE bunpm_worker_memory_rss_bytes gauge
bunpm_worker_memory_rss_bytes{app="api",worker="0"} 47382528
bunpm_worker_memory_rss_bytes{app="api",worker="1"} 45219840

# HELP bunpm_worker_cpu_percent Worker CPU usage percentage
# TYPE bunpm_worker_cpu_percent gauge
bunpm_worker_cpu_percent{app="api",worker="0"} 2.1
bunpm_worker_cpu_percent{app="api",worker="1"} 1.8

# HELP bunpm_worker_restarts_total Total worker restarts
# TYPE bunpm_worker_restarts_total counter
bunpm_worker_restarts_total{app="api",worker="0"} 0
bunpm_worker_restarts_total{app="api",worker="1"} 1

# HELP bunpm_worker_uptime_seconds Worker uptime in seconds
# TYPE bunpm_worker_uptime_seconds gauge
bunpm_worker_uptime_seconds{app="api",worker="0"} 8100
bunpm_worker_uptime_seconds{app="api",worker="1"} 8100

# HELP bunpm_app_workers_online Number of online workers
# TYPE bunpm_app_workers_online gauge
bunpm_app_workers_online{app="api"} 4
bunpm_app_workers_online{app="queue-worker"} 2

# HELP bunpm_app_workers_errored Number of errored workers
# TYPE bunpm_app_workers_errored gauge
bunpm_app_workers_errored{app="api"} 0

# HELP bunpm_master_uptime_seconds Master process uptime
# TYPE bunpm_master_uptime_seconds gauge
bunpm_master_uptime_seconds 29160
```

---

## 15. SQLite State

### 15.1 Schema

```sql
-- ~/.bunpm/bunpm.db

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA cache_size = -8000;       -- 8MB cache
PRAGMA temp_store = MEMORY;

-- Registry delle app
CREATE TABLE apps (
  name           TEXT PRIMARY KEY,
  config_json    TEXT NOT NULL,         -- JSON serializzato di AppConfig
  config_path    TEXT,                  -- path al config file originale
  status         TEXT NOT NULL DEFAULT 'stopped',  -- running | stopped | errored
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- Record dei worker
CREATE TABLE workers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  app_name       TEXT NOT NULL REFERENCES apps(name) ON DELETE CASCADE,
  worker_id      INTEGER NOT NULL,     -- 0-based index
  pid            INTEGER,
  state          TEXT NOT NULL DEFAULT 'stopped',
  started_at     INTEGER,
  ready_at       INTEGER,
  stopped_at     INTEGER,
  exit_code      INTEGER,
  signal_code    TEXT,
  restart_count  INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,

  UNIQUE(app_name, worker_id)
);

-- Storico restart (per analisi crash)
CREATE TABLE restart_history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  app_name       TEXT NOT NULL,
  worker_id      INTEGER NOT NULL,
  pid            INTEGER NOT NULL,
  exit_code      INTEGER,
  signal_code    TEXT,
  uptime_ms      INTEGER,              -- quanto e' durato il worker
  crash_reason   TEXT,
  restarted_at   INTEGER NOT NULL
);

CREATE INDEX idx_restart_history_app
  ON restart_history(app_name, restarted_at);

-- Snapshot metriche (aggregate, non raw)
CREATE TABLE metric_snapshots (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  app_name       TEXT NOT NULL,
  worker_id      INTEGER NOT NULL,
  timestamp      INTEGER NOT NULL,
  rss_bytes      INTEGER,
  heap_used      INTEGER,
  cpu_percent    REAL,
  event_loop_lag REAL,
  custom_json    TEXT
);

CREATE INDEX idx_metric_snapshots_app_time
  ON metric_snapshots(app_name, timestamp);
```

### 15.2 Cleanup automatico

Background task ogni 60 secondi:

```sql
-- Mantieni solo ultime 24h di snapshot metriche
DELETE FROM metric_snapshots
  WHERE timestamp < (strftime('%s','now') * 1000 - 86400000);

-- Mantieni solo ultimi 1000 restart per app
DELETE FROM restart_history
  WHERE id NOT IN (
    SELECT id FROM restart_history ORDER BY id DESC LIMIT 1000
  );
```

### 15.3 Vantaggi di SQLite vs pidfile

| Aspetto | pidfile | SQLite |
|---------|---------|--------|
| Restart history | Perso | Persistente |
| Crash count per window | In-memory, perso al restart daemon | Persistente |
| Metriche storiche | Nessuna | Ultime 24h |
| Config snapshot | Nessuno | Salvato per recovery |
| Concorrenza | Lock file fragile | WAL mode, reads concorrenti |
| Query | Impossibile | SQL arbitrario (debug, analytics) |
| Recovery dopo crash daemon | Nessuno | Ricostruisce stato completo |

---

## 16. Control Protocol (CLI ↔ Daemon)

### 16.1 Transport

Unix domain socket a `~/.bunpm/bunpm.sock`. Il file socket serve anche come check "daemon attivo?" (connessione fallisce = daemon non gira).

### 16.2 Wire Protocol

**NDJSON** (newline-delimited JSON) su Unix socket stream.

```
CLIENT si connette a ~/.bunpm/bunpm.sock
CLIENT invia: {"id":"abc123","cmd":"list","args":{}}\n
SERVER invia: {"id":"abc123","ok":true,"data":[...]}\n
CLIENT chiude (o mantiene per streaming)
```

### 16.3 Formato messaggi

```typescript
/** Richiesta dal CLI */
interface ControlRequest {
  id: string;                    // UUID per correlazione
  cmd: string;                   // nome comando
  args: Record<string, unknown>;
}

/** Risposta dal daemon */
interface ControlResponse {
  id: string;                    // matcha request.id
  ok: boolean;
  data?: unknown;
  error?: string;
}

/** Risposta streaming (per logs, monit) */
interface ControlStreamChunk {
  id: string;
  stream: true;
  data: unknown;
  done?: boolean;                // true = ultimo chunk
}
```

### 16.4 Comandi disponibili

| Comando | Args | Risposta |
|---------|------|----------|
| `list` | `{}` | Array di AppStatus |
| `start` | `{ config?, script?, instances?, port?, name? }` | `{ ok: true }` |
| `stop` | `{ app: string }` | `{ ok: true }` |
| `restart` | `{ app: string, force?: boolean }` | `{ ok: true }` |
| `reload` | `{ app: string }` | `{ ok: true }` (streaming progress) |
| `delete` | `{ app: string }` | `{ ok: true }` |
| `status` | `{ app: string }` | Stato dettagliato |
| `logs` | `{ app: string, lines?: number }` | Streaming log chunks |
| `metrics` | `{ app: string }` | Metriche correnti |
| `ping` | `{}` | `{ ok: true, uptime: number }` |
| `dump` | `{}` | Stato completo interno (debug) |
| `kill-daemon` | `{}` | `{ ok: true }` + daemon termina |

### 16.5 Perche' NDJSON e non msgpack

Il control plane vede ~10 messaggi/secondo al picco. NDJSON aggiunge ~50μs di overhead per messaggio rispetto a msgpack. In cambio:
- Human-debuggable: `socat UNIX:~/.bunpm/bunpm.sock -` per debug
- Zero dipendenze: `JSON.parse`/`JSON.stringify` nativi e ottimizzati
- Bun ottimizza JSON via SIMD internamente

---

## 17. Daemon vs Foreground

### 17.1 Foreground (default)

```bash
bunpm start bunpm.config.ts              # foreground, default
bunpm start bunpm.config.ts --no-daemon  # esplicito
```

Comportamento:
- Master resta in primo piano (PID 1 in Docker)
- stdout/stderr dei worker multiplexati con prefissi `[app:id]`
- SIGTERM/SIGINT → graceful shutdown di tutti i worker
- SIGHUP → reload (zero-downtime restart)
- Control socket attivo (CLI puo' connettersi)
- Nessun PID file necessario

**Uso tipico:** Docker, Kubernetes, systemd, qualsiasi supervisor esterno.

### 17.2 Daemon

```bash
bunpm start bunpm.config.ts --daemon
# oppure
bunpm daemon start
```

Comportamento:
- Master si stacca dal terminale
- PID file in `~/.bunpm/bunpm.pid`
- stdout/stderr del master in `~/.bunpm/bunpm-daemon.log`
- Worker log nei file `~/.bunpm/logs/`
- CLI comunica via Unix socket

**Uso tipico:** Server bare metal, VPS, deployment tradizionali.

### 17.3 Implementazione daemonization

Bun non ha `fork()` nativo. L'approccio usa Bun.spawn per lanciare un processo figlio:

```typescript
function daemonize(configPath: string): void {
  const child = Bun.spawn({
    cmd: ['bun', 'run', import.meta.dir + '/master.ts',
          '--config', configPath, '--daemonized'],
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, BUNPM_DAEMON: '1' },
  });

  // Il figlio unref se stesso dal parent
  child.unref();

  // Scrivi PID file
  Bun.write(PID_FILE, String(child.pid));
  console.log(`[bunpm] Daemon avviato, pid ${child.pid}`);
  process.exit(0);
}
```

---

## 18. Graceful Shutdown

### 18.1 Sequenza

```
Signal ricevuto (SIGTERM/SIGINT)
  │
  ▼
[1] Master imposta stato = "shutting_down"
    Smette di accettare nuovi comandi CLI
  │
  ▼
[2] PER OGNI app (in parallelo):
      PER OGNI worker (in parallelo):
        a) Invia IPC: { type: 'shutdown', timeout: killTimeout }
        b) Worker state → "draining"
        c) Proxy mode: rimuovi worker dal round-robin
        d) Avvia kill timer (killTimeout ms)
  │
  ▼
[3] Attendi che tutti i worker escano:
    - Worker esce pulito → state = "stopped", cancella kill timer
    - Kill timer scade → SIGKILL, state = "stopped"
  │
  ▼
[4] Tutti i worker fermati
    Persisti stato finale su SQLite
    Chiudi connessione SQLite
    Rimuovi socket file (daemon mode)
    Rimuovi PID file (daemon mode)
  │
  ▼
[5] Master esce con codice 0
```

### 18.2 Signal handling nel master

```typescript
function setupSignalHandlers(master: MasterProcess): void {
  process.on('SIGTERM', () => master.shutdown('SIGTERM'));
  process.on('SIGINT',  () => master.shutdown('SIGINT'));
  process.on('SIGHUP',  () => master.reloadAll());
  process.on('SIGPIPE', () => {});  // ignora broken pipe
}
```

### 18.3 Timeout

| Config | Default | Descrizione |
|--------|---------|-------------|
| `killTimeout` | 5000ms | Tempo per graceful exit dopo SIGTERM |
| `shutdownSignal` | SIGTERM | Segnale inviato per primo |

Se il worker non esce entro `killTimeout`, il master invia `SIGKILL` (non intercettabile, uscita forzata).

---

## 19. Security

### 19.1 Unix Socket Permissions

```typescript
import { chmodSync } from 'node:fs';
chmodSync(SOCKET_PATH, 0o600);  // solo owner read/write
```

### 19.2 Environment Sanitization

Il master NON passa le proprie variabili interne ai worker:

```typescript
const INTERNAL_KEYS = new Set([
  'BUNPM_DAEMON',
  'BUNPM_CONTROL_SOCKET',
  'BUNPM_INTERNAL_PORT_BASE',
]);

function sanitizeEnv(masterEnv: NodeJS.ProcessEnv, workerEnv: Record<string, string>): Record<string, string> {
  const env = { ...masterEnv, ...workerEnv };
  for (const key of INTERNAL_KEYS) delete env[key];
  return env;
}
```

### 19.3 PID File Safety

- Al startup, controlla se il PID nel file e' un processo bunpm attivo
- `process.kill(pid, 0)` verifica esistenza senza inviare segnali
- Se il PID e' stale (processo non esiste), sovrascrive il file

### 19.4 IPC Message Validation

```typescript
function isValidWorkerMessage(msg: unknown): msg is WorkerMessage {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as any;
  return ['ready', 'metrics', 'heartbeat', 'custom'].includes(m.type);
}
```

Messaggi con tipo sconosciuto vengono loggati e scartati. Mai `eval()` sui dati IPC.

### 19.5 SQLite Safety

- Database `~/.bunpm/bunpm.db` con mode `0o600`
- Tutte le query usano prepared statement (injection-safe)
- WAL mode previene writer starvation

---

## 20. Directory Structure

```
bunpm/
├── package.json
├── tsconfig.json
├── bunpm.config.example.ts
├── bunpm-design.md
│
├── src/
│   ├── index.ts                          # Entry point, CLI router
│   ├── constants.ts                      # Path, defaults
│   │
│   ├── cli/
│   │   ├── index.ts                      # Argument parsing (Bun.argv)
│   │   ├── format.ts                     # Table/output formatting
│   │   └── commands/
│   │       ├── start.ts
│   │       ├── stop.ts
│   │       ├── restart.ts
│   │       ├── reload.ts
│   │       ├── delete.ts
│   │       ├── list.ts
│   │       ├── status.ts
│   │       ├── logs.ts
│   │       ├── metrics.ts
│   │       ├── monit.ts                  # TUI real-time dashboard
│   │       ├── daemon.ts
│   │       └── init.ts
│   │
│   ├── core/
│   │   ├── master.ts                     # Master orchestrator
│   │   ├── process-manager.ts            # Spawn, kill, lifecycle
│   │   ├── lifecycle.ts                  # State machine, transizioni
│   │   ├── backoff.ts                    # Crash recovery
│   │   └── signals.ts                    # Signal handler
│   │
│   ├── config/
│   │   ├── loader.ts                     # Carica .ts/.json
│   │   ├── validator.ts                  # Validazione + defaults
│   │   └── types.ts                      # Interfacce TypeScript
│   │
│   ├── ipc/
│   │   ├── protocol.ts                   # Tipi messaggio IPC
│   │   └── router.ts                     # Message dispatch nel master
│   │
│   ├── control/
│   │   ├── server.ts                     # Unix socket server
│   │   ├── client.ts                     # CLI-side socket client
│   │   ├── protocol.ts                   # NDJSON wire protocol
│   │   └── handlers.ts                   # Command handlers
│   │
│   ├── cluster/
│   │   ├── platform.ts                   # Detect strategy per OS
│   │   ├── reuse-port.ts                 # reusePort (Linux)
│   │   └── proxy.ts                      # TCP proxy (macOS)
│   │
│   ├── health/
│   │   └── checker.ts                    # Health check logic
│   │
│   ├── logs/
│   │   ├── manager.ts                    # Log capture + routing
│   │   └── writer.ts                     # File writer con rotazione
│   │
│   ├── metrics/
│   │   ├── aggregator.ts                 # Raccolta metriche
│   │   ├── prometheus.ts                 # Prometheus format export
│   │   └── http-server.ts               # HTTP endpoint metriche
│   │
│   ├── store/
│   │   └── sqlite.ts                     # SQLite store + schema
│   │
│   ├── daemon/
│   │   ├── daemonize.ts                  # Fork/detach logic
│   │   └── pid.ts                        # PID file management
│   │
│   └── sdk/
│       └── worker.ts                     # Worker-side SDK
│
├── test/
│   ├── core/
│   │   ├── master.test.ts
│   │   ├── process-manager.test.ts
│   │   ├── lifecycle.test.ts
│   │   └── backoff.test.ts
│   ├── cluster/
│   │   └── proxy.test.ts
│   ├── health/
│   │   └── checker.test.ts
│   ├── control/
│   │   ├── server.test.ts
│   │   └── client.test.ts
│   ├── store/
│   │   └── sqlite.test.ts
│   ├── logs/
│   │   └── manager.test.ts
│   └── integration/
│       ├── full-lifecycle.test.ts
│       ├── reload.test.ts
│       └── crash-recovery.test.ts
│
└── fixtures/
    ├── sample-server.ts
    ├── crashing-server.ts
    └── slow-start-server.ts
```

### Stima LOC

| Modulo | Source LOC | Test LOC |
|--------|-----------|----------|
| cli/ | ~1,540 | - |
| core/ | ~1,020 | ~770 |
| config/ | ~500 | - |
| ipc/ | ~230 | - |
| control/ | ~710 | ~350 |
| cluster/ | ~340 | ~200 |
| health/ | ~180 | ~150 |
| logs/ | ~350 | ~150 |
| metrics/ | ~400 | - |
| store/ | ~360 | ~200 |
| daemon/ | ~180 | - |
| sdk/ | ~100 | - |
| integration test | - | ~700 |
| **Totale** | **~5,910** | **~2,520** |
| **Grand Total** | | **~8,430** |

---

## 21. Performance Targets

| Operazione | Target | Note |
|-----------|--------|------|
| Worker spawn | <50ms | Bun.spawn() e' 60% piu' veloce di Node |
| Worker ready (con SDK) | <100ms | IPC "ready" immediato |
| Worker ready (senza SDK) | <5s | HTTP health check fallback |
| Zero-downtime reload (4 worker) | <10s | 4 batch x (spawn + ready + drain) |
| Memory overhead master | <20 MB | Solo supervisione, no user code |
| Memory overhead per worker | ~2 KB tracking | Stato in-memory nel master |
| Proxy latency (macOS) | <100μs | TCP forwarding, no parsing |
| Health check overhead | <1ms | fetch() locale |
| Metrics collection | <1ms per worker | IPC message, no I/O |
| CLI response time | <50ms | Unix socket + JSON parse |
| SQLite write (state update) | <1ms | WAL mode, prepared statements |
| Log write overhead | <10μs per riga | Bun.write() buffered |
| Crash detection | <1s | process.exited event immediato |
| Signal propagation | <10ms | Master → SIGTERM → tutti i worker |

---

## 22. Confronto Finale

```
                 bunpm              PM2               systemd           Docker
──────────────────────────────────────────────────────────────────────────────────
Runtime          Bun (TS)          Node.js            C                 Go
Dipendenze       0                 ~150 npm pkgs      OS built-in       Container
Install size     Single binary     ~50MB node_modules N/A               N/A
Boot time        <50ms             ~500ms             ~100ms            ~1s
Memory (master)  ~20MB             ~60-80MB           ~1MB              N/A
Clustering       reusePort/proxy   node:cluster       N/A               Replicas
Bun support      Nativo            Rotto (cluster)    Manuale           Ok
Crash recovery   Exp backoff       Fixed delay        Configurable      RestartPolicy
Health checks    IPC + HTTP        None built-in      Watchdog/HTTP     HTTP/TCP/CMD
Metrics          Prometheus        PM2 Plus ($)       journald          cAdvisor
Zero-downtime    bunpm reload      pm2 reload         Manual            Rolling update
Log rotation     Built-in          Built-in           journald          Docker driver
Foreground       Default           Opzionale          N/A (always bg)   Default
Daemon           Opzionale         Default            Default           N/A
Config           .ts / .json       ecosystem.json     .service file     Dockerfile
State persist    SQLite            In-memory          systemd state     etcd
Platform         Linux + macOS     Cross-platform     Linux only        Cross-platform
```

---

## 23. Roadmap di Implementazione

### Fase 1: Core MVP (~2 settimane)

Obiettivo: singola app, foreground mode, clustering base, crash restart.

- [ ] Interfacce TypeScript (types.ts)
- [ ] Config loader (.ts + .json)
- [ ] Config validator + defaults
- [ ] State machine lifecycle
- [ ] ProcessManager (Bun.spawn, IPC setup)
- [ ] Master orchestrator
- [ ] Crash recovery con exponential backoff
- [ ] Signal handling (SIGTERM, SIGINT, SIGHUP)
- [ ] Cluster: reusePort strategy (Linux)
- [ ] Worker SDK (bunpmReady, bunpmOnShutdown, bunpmStartMetrics)
- [ ] CLI base: start, stop, list
- [ ] Foreground mode con log multiplexing
- [ ] Test: lifecycle, backoff, process manager

**Deliverable:** `bunpm start server.ts -i 4 --port 3000` funziona su Linux. Worker si riavviano al crash. Ctrl+C fa graceful shutdown.

### Fase 2: macOS + Control Socket (~1.5 settimane)

Obiettivo: clustering su macOS, CLI completa.

- [ ] Cluster: TCP proxy (macOS)
- [ ] Platform detection automatica
- [ ] Control server (Unix socket, NDJSON)
- [ ] Control client (CLI side)
- [ ] Command handlers (tutti i comandi)
- [ ] CLI: restart, reload, status, delete
- [ ] Zero-downtime reload (rolling restart)
- [ ] Test: proxy, control protocol, reload

**Deliverable:** CLI completa. `bunpm reload` fa zero-downtime restart. macOS supportato.

### Fase 3: Persistenza + Logging (~1 settimana)

Obiettivo: SQLite state, log management.

- [ ] SQLite store + schema
- [ ] Persist app registry, worker state
- [ ] Restart history tracking
- [ ] Recovery da crash del daemon
- [ ] Log capture (stdout/stderr pipe)
- [ ] Log writer con rotazione per dimensione
- [ ] CLI: logs (streaming)
- [ ] Test: SQLite store, log rotation

**Deliverable:** Stato persiste tra restart daemon. Log catturati e ruotati.

### Fase 4: Metriche + Health Checks (~1 settimana)

Obiettivo: observability completa.

- [ ] Health checker (IPC heartbeat + HTTP probe)
- [ ] Restart worker unhealthy
- [ ] Metrics aggregator (CPU %, memory)
- [ ] Prometheus export format
- [ ] HTTP metrics server
- [ ] Metric snapshots su SQLite
- [ ] Cleanup automatico (24h retention)
- [ ] CLI: metrics, status dettagliato
- [ ] Test: health checker, metrics

**Deliverable:** Endpoint Prometheus funzionante. Worker unhealthy riavviati.

### Fase 5: Daemon + Polish (~1 settimana)

Obiettivo: production-ready, daemon mode, TUI.

- [ ] Daemonize (Bun.spawn detached)
- [ ] PID file management
- [ ] CLI: daemon start/stop/status
- [ ] CLI: monit (TUI dashboard real-time)
- [ ] CLI: init (genera config di esempio)
- [ ] CLI: startup (genera systemd/launchd)
- [ ] Table formatting per output CLI
- [ ] Test: integration full lifecycle, crash recovery
- [ ] Benchmark: spawn time, reload time, memory overhead

**Deliverable:** `bunpm daemon start` funziona. `bunpm monit` mostra dashboard. Pronto per produzione.

**Totale stimato: 6-7 settimane**

---

## 24. Appendice: Dockerfile

```dockerfile
FROM oven/bun:1.3

WORKDIR /app
COPY . .
RUN bun install

# bunpm come PID 1 in foreground mode
CMD ["bunpm", "start", "bunpm.config.ts"]
```

`bunpm` in foreground mode gestisce SIGTERM da Docker/K8s, fa graceful shutdown di tutti i worker, e esce con codice 0.
