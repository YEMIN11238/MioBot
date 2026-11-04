# T3 Code connection recovery integration

MioBot adapts the equal-jitter exponential retry function from **T3 Code** by
T3 Tools Inc., licensed under MIT. It is not represented as original MioBot code.

- Repository: https://github.com/pingdotgg/t3code
- Pinned commit: `8b44f42b14c8e273156474a924ccf29680dd7857`
- Original file: `packages/client-runtime/src/connection/supervisor.ts`
- Exact retained source excerpt: `upstream/supervisor-retry.ts`
- Original license: [LICENSE](LICENSE)

`src/connection-recovery.mjs` retains the retry formula, its 1,000 ms base and
300,000 ms maximum, removing only TypeScript type annotations. The integration
also uses a 30-second stable period before resetting a retry ladder. The new
MioBot lifecycle controller translates connection management to the existing
HTTP/SSE application: one synchronization owner, foreground/network wakeups,
no overlapping refreshes, suspension-aware polling, authorization failure
parking, and bounded timeouts. The controller and its read-only API integration
are MioBot code, not a copy of T3's complete Effect-based supervisor.

This integration does not install the T3 Code app or its coding providers,
Git/terminal tools, React Native app, Clerk identity, Cloudflare infrastructure,
T3 Connect service, APNs/FCM credentials or mobile push service. No T3 account,
subscription, private project, user conversation or credential is included.

Reconnection refreshes authoritative server state. It never automatically
replays a chat submission, reminder creation or another write operation.
The same code is intended for desktop and mobile views; actual mobile and
deployment acceptance is recorded separately by the MioBot project.
