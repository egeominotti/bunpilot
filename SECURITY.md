# Security policy

## Supported versions

Security fixes are provided for the latest stable 1.x release.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use [GitHub private vulnerability reporting](https://github.com/egeominotti/bunpilot/security/advisories/new) and include affected versions, reproduction steps, impact, and any proposed mitigation.

The daemon control socket is a same-user local administration interface. Do not expose it through a network share or proxy. Keep `BUNPILOT_HOME`, custom PID paths, sockets, logs, configs, and application scripts writable only by trusted users.
