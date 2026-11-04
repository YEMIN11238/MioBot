/*
 * retryDelayMs is adapted from T3 Code, Copyright (c) 2026 T3 Tools Inc.
 * MIT license and the exact upstream excerpt: integrations/t3code/.
 * The polling/lifecycle controller below is MioBot integration code.
 */
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 300_000;
const BACKOFF_RESET_AFTER_MS = 30_000;

/** Equal jitter keeps reconnecting devices from retrying in the same instant. */
export function retryDelayMs(failureCount, random) {
  const ceiling = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (failureCount + 1));
  return Math.round(ceiling / 2 + (ceiling / 2) * random);
}

/** One read-only synchronization owner per mounted client. Never replays writes. */
export function createConnectionRecovery({
  refresh, onStatus = () => {}, window: windowTarget = globalThis.window,
  document: documentTarget = globalThis.document, pollMs = 2500, timeoutMs = 12000,
  random = Math.random, now = Date.now, setTimeout: later = globalThis.setTimeout,
  clearTimeout: cancel = globalThis.clearTimeout,
} = {}) {
  if (typeof refresh !== 'function') throw new TypeError('A refresh function is required');
  let active = false, generation = 0, timer = null, deadline = null, controller = null;
  let inFlight = null, pendingWake = false, failures = 0, readySince = null;
  let state = {phase: 'stopped', syncing: false, attempt: 0, error: '', retryAt: null, lastSyncedAt: null};
  const hidden = () => documentTarget?.visibilityState === 'hidden' || documentTarget?.hidden === true;
  const offline = () => windowTarget?.navigator?.onLine === false;
  const update = (phase, patch = {}) => { state = {...state, phase, ...patch}; onStatus({...state}); };
  const clearPoll = () => { if (timer !== null) cancel(timer); timer = null; };
  const schedule = delay => {
    clearPoll();
    if (active && !hidden()) timer = later(() => { timer = null; void run('poll'); }, Math.max(0, delay));
  };
  async function run(reason) {
    if (!active) return;
    if (hidden()) { clearPoll(); update('suspended', {syncing: false, retryAt: null}); return; }
    if (inFlight) { if (reason !== 'poll') pendingWake = true; return inFlight; }
    clearPoll();
    const currentGeneration = generation, attempt = failures + 1;
    const attemptController = new AbortController();
    controller = attemptController;
    const signal = attemptController.signal;
    update(state.phase === 'ready' ? 'ready' : 'connecting', {syncing: true, attempt, retryAt: null});
    inFlight = (async () => {
      try {
        const timeout = new Promise((_, reject) => {
          deadline = later(() => {
            attemptController.abort();
            reject(Object.assign(new Error('连接超时，请检查后台是否在线。'), {code: 'CONNECTION_TIMEOUT'}));
          }, timeoutMs);
        });
        await Promise.race([Promise.resolve().then(() => refresh({signal, reason})), timeout]);
        if (!active || currentGeneration !== generation) return;
        const syncedAt = now();
        if (readySince === null) readySince = syncedAt;
        if (syncedAt - readySince >= BACKOFF_RESET_AFTER_MS) failures = 0;
        update(hidden() ? 'suspended' : 'ready', {syncing: false, error: '', retryAt: null, lastSyncedAt: syncedAt});
      } catch (error) {
        if (!active || currentGeneration !== generation) return;
        readySince = null;
        const message = String(error?.message || '暂时无法连接后台。').slice(0, 240);
        if (error?.status === 401 || error?.status === 403) {
          update('blocked', {syncing: false, error: message, retryAt: null});
        } else if (offline()) {
          update('offline', {syncing: false, error: message, retryAt: null});
        } else {
          const delay = retryDelayMs(failures++, random());
          update('backoff', {syncing: false, error: message, retryAt: now() + delay});
        }
      } finally {
        if (currentGeneration !== generation) return;
        if (deadline !== null) cancel(deadline);
        deadline = null; controller = null; inFlight = null;
        if (!active) return;
        if (pendingWake) { pendingWake = false; void run('wakeup'); }
        else if (state.phase === 'ready') schedule(pollMs);
        else if (state.phase === 'backoff') schedule(state.retryAt - now());
      }
    })();
    return inFlight;
  }
  function wake(reason = 'manual') {
    if (!active) return;
    failures = 0; readySince = null; clearPoll();
    return run(reason);
  }
  const onVisible = () => {
    if (hidden()) { clearPoll(); update('suspended', {syncing: false, retryAt: null}); }
    else void wake('foreground');
  };
  const onOnline = () => { void wake('online'); };
  const onOffline = () => { void wake('network-changed'); };
  const onFocus = () => { void wake('foreground'); };
  const events = [[documentTarget, 'visibilitychange', onVisible], [windowTarget, 'online', onOnline],
    [windowTarget, 'offline', onOffline], [windowTarget, 'focus', onFocus], [windowTarget, 'pageshow', onFocus]];
  return {
    start() {
      if (active) return inFlight;
      active = true; generation++;
      for (const [target, name, listener] of events) target?.addEventListener?.(name, listener);
      return run('start');
    },
    stop() {
      if (!active) return;
      active = false; generation++; pendingWake = false; clearPoll();
      if (deadline !== null) cancel(deadline);
      deadline = null; controller?.abort(); controller = null; inFlight = null;
      for (const [target, name, listener] of events) target?.removeEventListener?.(name, listener);
      update('stopped', {syncing: false, retryAt: null});
    },
    wake,
    getState() { return {...state}; },
  };
}
