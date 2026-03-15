/**
 * src/reconnect.js — reconnect helpers, isolated for testing.
 *
 * Browser: index.html loads this via <script src="src/reconnect.js"> then
 *   calls makeReconnectModule({…}) to wire in live dependencies.
 * Node/Jest: require('../src/reconnect') gives the same exports.
 */

/**
 * Factory that returns the three reconnect functions with dependencies
 * injected so they can be exercised in unit tests without a browser or DOM.
 *
 * @param {object} deps
 * @param {function} deps.getNet       — () => net  (returns the live net object)
 * @param {function} deps.newPeer      — (id) => Peer  (injected; tests mock this)
 * @param {function} deps.stopPing     — () => void
 * @param {function} deps.updateBadge  — (status: string) => void
 * @param {function} deps.onConnReopen — () => void
 * @param {function} deps.onConnData   — (data) => void
 * @param {function} deps.onConnClose  — () => void
 * @param {function} deps.now          — () => number  (injected for testability)
 */
function makeReconnectModule({
  getNet,
  newPeer,
  stopPing,
  updateBadge,
  onConnReopen,
  onConnData,
  onConnClose,
  now,
}) {
  function handleConnLost() {
    stopPing();
    const net = getNet();
    if (net.mode === 'local') return;
    if (net.reconnecting) return;
    net.reconnecting = true;
    net.reconnectStart = now();
    try { if (net.conn) net.conn.close(); } catch(e) {}
    net.conn = null;
    updateBadge('reconnecting');
    if (net.mode === 'guest') setTimeout(attemptGuestReconnect, 2000);
    // Host just waits — its peer stays alive and the guest will reconnect.
  }

  function attemptGuestReconnect() {
    const net = getNet();
    if (!net.reconnecting || net.mode !== 'guest' || !net.code) return;
    if (!net.peer || net.peer.destroyed) {
      try { if (net.peer) net.peer.destroy(); } catch(e) {}
      net.peer = newPeer(undefined);
      net.peer.on('open', guestConnectToPeer);
      net.peer.on('error', () => setTimeout(attemptGuestReconnect, 3000));
      return;
    }
    guestConnectToPeer();
  }

  function guestConnectToPeer() {
    const net = getNet();
    if (!net.reconnecting) return;
    // Give up only after 45 s of total reconnect attempts.
    if (now() - (net.reconnectStart || 0) > 45000) {
      net.reconnecting = false;
      updateBadge('disconnected');
      return;
    }
    try {
      const conn = net.peer.connect('ticto-' + net.code, { reliable: true });
      net.conn = conn;
      let ok = false;
      const t = setTimeout(() => {
        if (!ok && getNet().reconnecting) {
          // One attempt timed out — destroy peer for a clean slate and retry.
          try { conn.close(); } catch(e) {}
          try { if (net.peer && !net.peer.destroyed) net.peer.destroy(); } catch(e) {}
          setTimeout(attemptGuestReconnect, 2000);
        }
      }, 12000);
      conn.on('open', () => { ok = true; clearTimeout(t); onConnReopen(); });
      conn.on('data', onConnData);
      conn.on('close', onConnClose);
      conn.on('error', () => {
        clearTimeout(t);
        if (getNet().reconnecting) setTimeout(attemptGuestReconnect, 3000);
      });
    } catch(e) { setTimeout(attemptGuestReconnect, 3000); }
  }

  return { handleConnLost, attemptGuestReconnect, guestConnectToPeer };
}

/**
 * Pure helper — tells the host peer error handler whether to ignore an error.
 * Returns true when:
 *   - the error is a transient signaling-server blip, AND
 *   - either the DataChannel is still open OR a reconnect is already in flight.
 *
 * @param {string} errType
 * @param {object} net
 */
function shouldIgnoreHostPeerError(errType, net) {
  const isSignalingErr = ['network', 'server-error', 'socket-error', 'socket-closed']
    .includes(errType);
  return isSignalingErr && ((net.conn && net.conn.open) || net.reconnecting);
}

if (typeof module !== 'undefined') {
  module.exports = { makeReconnectModule, shouldIgnoreHostPeerError };
} else {
  window.makeReconnectModule = makeReconnectModule;
  window.shouldIgnoreHostPeerError = shouldIgnoreHostPeerError;
}
