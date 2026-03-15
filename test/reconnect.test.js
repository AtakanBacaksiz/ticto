'use strict';

const { makeReconnectModule, shouldIgnoreHostPeerError } = require('../src/reconnect');

// ─── helpers ────────────────────────────────────────────────────────────────

function makeNet(overrides = {}) {
  return {
    mode: 'local', peer: null, conn: null,
    myRole: null, code: null, reconnecting: false,
    ...overrides,
  };
}

/**
 * Build a fresh module instance with all external deps mocked.
 * Individual tests can override specific deps via depOverrides.
 */
function makeModule(netOverrides = {}, depOverrides = {}) {
  const net = makeNet(netOverrides);
  const deps = {
    getNet:       () => net,
    newPeer:      jest.fn(),
    stopPing:     jest.fn(),
    updateBadge:  jest.fn(),
    onConnReopen: jest.fn(),
    onConnData:   jest.fn(),
    onConnClose:  jest.fn(),
    now:          jest.fn(() => Date.now()),
    ...depOverrides,
  };
  const fns = makeReconnectModule(deps);
  return { net, deps, ...fns };
}

/** Minimal mock for a PeerJS DataConnection. */
function makeConn(handlers = {}) {
  const conn = {
    close: jest.fn(),
    on: jest.fn((event, cb) => { conn._handlers[event] = cb; }),
    _handlers: {},
    ...handlers,
  };
  return conn;
}

/** Minimal mock for a PeerJS Peer. */
function makePeer({ destroyed = false } = {}) {
  const peer = {
    destroyed,
    destroy: jest.fn(),
    connect: jest.fn(),
    on: jest.fn((event, cb) => { peer._handlers[event] = cb; }),
    _handlers: {},
  };
  return peer;
}

// ─── handleConnLost ─────────────────────────────────────────────────────────

describe('handleConnLost', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('sets net.reconnecting = true and records net.reconnectStart', () => {
    jest.setSystemTime(1_000_000);
    const { net, handleConnLost } = makeModule(
      { mode: 'guest', code: 'ABCD' },
      { now: () => Date.now() },
    );
    handleConnLost();
    expect(net.reconnecting).toBe(true);
    expect(net.reconnectStart).toBe(1_000_000);
  });

  test('is a no-op when already reconnecting (reconnectStart unchanged, badge not updated)', () => {
    const { net, deps, handleConnLost } = makeModule({
      mode: 'guest', code: 'ABCD', reconnecting: true, reconnectStart: 999,
    });
    handleConnLost();
    // stopPing is always called (harmless to call twice), but the rest should be unchanged.
    expect(net.reconnectStart).toBe(999);
    expect(deps.updateBadge).not.toHaveBeenCalled();
  });

  test('calls updateBadge("reconnecting") for guest mode', () => {
    const { deps, handleConnLost } = makeModule(
      { mode: 'guest', code: 'ABCD' },
    );
    handleConnLost();
    expect(deps.updateBadge).toHaveBeenCalledWith('reconnecting');
  });

  test('does not schedule attemptGuestReconnect for host mode', () => {
    const mockPeer = makePeer();
    const { handleConnLost } = makeModule({ mode: 'host', code: 'ABCD' });
    handleConnLost();
    jest.runAllTimers();
    // No assertion needed — just verifying no exception is thrown and no
    // attempt to call newPeer (which would explode without a mock return value).
  });

  test('schedules attemptGuestReconnect after 2 s for guest mode', () => {
    const mockPeer = makePeer({ destroyed: true });
    const { deps, handleConnLost } = makeModule(
      { mode: 'guest', code: 'ABCD' },
      { newPeer: jest.fn(() => mockPeer) },
    );
    handleConnLost();
    expect(deps.newPeer).not.toHaveBeenCalled(); // not yet
    jest.advanceTimersByTime(2000);
    // attemptGuestReconnect ran and created a new peer
    expect(deps.newPeer).toHaveBeenCalledTimes(1);
  });
});

// ─── guestConnectToPeer — retry / give-up logic ──────────────────────────────

describe('guestConnectToPeer — retry / give-up', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('does NOT give up after first 12 s attempt when total time < 45 s', () => {
    const startTime = 1_000_000;
    jest.setSystemTime(startTime);

    const conn = makeConn();
    const peer = makePeer();
    peer.connect.mockReturnValue(conn);

    const { net, deps, guestConnectToPeer } = makeModule(
      { mode: 'guest', code: 'ABCD', reconnecting: true, reconnectStart: startTime, peer },
      { now: () => Date.now() },
    );
    net.peer = peer;

    guestConnectToPeer();

    // Advance only 12 s — still within the 45 s budget.
    jest.advanceTimersByTime(12000);

    expect(deps.updateBadge).not.toHaveBeenCalledWith('disconnected');
    expect(net.reconnecting).toBe(true);
  });

  test('gives up with updateBadge("disconnected") after 45 s total elapsed', () => {
    const now = 1_045_001; // reconnectStart is 45001 ms ago → over budget
    const { net, deps, guestConnectToPeer } = makeModule(
      { mode: 'guest', code: 'ABCD', reconnecting: true, reconnectStart: now - 45001 },
      { now: () => now },
    );

    guestConnectToPeer();

    expect(net.reconnecting).toBe(false);
    expect(deps.updateBadge).toHaveBeenCalledWith('disconnected');
  });

  test('retries via guestConnectToPeer when a 12 s attempt times out (total < 45 s)', () => {
    const startTime = 1_000_000;
    jest.setSystemTime(startTime);

    const conn = makeConn();
    const peer = makePeer();
    peer.connect.mockReturnValue(conn);

    const { net, guestConnectToPeer } = makeModule(
      { mode: 'guest', code: 'ABCD', reconnecting: true, reconnectStart: startTime, peer },
      { now: () => Date.now() },
    );
    net.peer = peer;

    guestConnectToPeer();
    expect(peer.connect).toHaveBeenCalledTimes(1);

    // 12 s timeout fires — destroys peer and schedules a retry after 2 s
    jest.advanceTimersByTime(12000);
    // 2 s later the retry fires and calls guestConnectToPeer again
    jest.advanceTimersByTime(2000);

    // connect was called a second time → retry happened
    expect(peer.connect).toHaveBeenCalledTimes(2);
  });
});

// ─── guestConnectToPeer — happy path ─────────────────────────────────────────

describe('guestConnectToPeer — successful connection', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('calls onConnReopen when conn.open fires and does not give up after 12 s', () => {
    const startTime = 1_000_000;
    jest.setSystemTime(startTime);

    const conn = makeConn();
    const peer = makePeer();
    peer.connect.mockReturnValue(conn);

    const { net, deps, guestConnectToPeer } = makeModule(
      { mode: 'guest', code: 'ABCD', reconnecting: true, reconnectStart: startTime, peer },
      { now: () => Date.now() },
    );
    net.peer = peer;

    guestConnectToPeer();

    // Simulate conn.open firing before the 12 s deadline
    conn._handlers['open']();

    expect(deps.onConnReopen).toHaveBeenCalledTimes(1);

    // Advance past 12 s — the timeout callback should be a no-op (ok = true)
    jest.advanceTimersByTime(13000);

    expect(deps.updateBadge).not.toHaveBeenCalledWith('disconnected');
  });
});

// ─── shouldIgnoreHostPeerError ────────────────────────────────────────────────

describe('shouldIgnoreHostPeerError', () => {
  const SIGNALING_ERRORS = ['network', 'server-error', 'socket-error', 'socket-closed'];
  const NON_SIGNALING_ERRORS = ['unavailable-id', 'peer-unavailable', 'browser-incompatible'];

  test('returns true for all signaling errors when net.reconnecting is true', () => {
    const net = { reconnecting: true, conn: null };
    for (const errType of SIGNALING_ERRORS) {
      expect(shouldIgnoreHostPeerError(errType, net)).toBe(true);
    }
  });

  test('returns true for signaling errors when conn.open is true (active connection)', () => {
    const net = { reconnecting: false, conn: { open: true } };
    for (const errType of SIGNALING_ERRORS) {
      expect(shouldIgnoreHostPeerError(errType, net)).toBe(true);
    }
  });

  test('returns false for signaling errors when not reconnecting and no open conn', () => {
    const net = { reconnecting: false, conn: null };
    for (const errType of SIGNALING_ERRORS) {
      expect(shouldIgnoreHostPeerError(errType, net)).toBe(false);
    }
  });

  test('returns false for non-signaling errors even when reconnecting', () => {
    const net = { reconnecting: true, conn: null };
    for (const errType of NON_SIGNALING_ERRORS) {
      expect(shouldIgnoreHostPeerError(errType, net)).toBe(false);
    }
  });

  test('returns false when conn exists but is not open', () => {
    const net = { reconnecting: false, conn: { open: false } };
    expect(shouldIgnoreHostPeerError('network', net)).toBe(false);
  });
});
