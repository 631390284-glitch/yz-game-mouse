// Cursor clutch core (v50: extracted from electron-main.js, and fixed).
//
// The clutch gates cursor movement on a key (hold/toggle) or a spoken
// command. While disengaged, the real cursor is frozen and the renderer's
// pointer is pinned onto it; while engaged, the applied position is the
// head-tracked target minus a translation (`offset`) that stitches the
// renderer's coordinate frame back onto wherever the real cursor is.
//
// THE BUG THIS MODULE FIXES (v50). The offset used to be computed against an
// anchor that was captured ONCE, at the moment of disengage:
//
//     anchor = curPos (first blocked frame)   <- frozen forever
//     offset = headTarget - anchor
//
// Any real-cursor movement between that capture and re-engage then lived on
// inside `offset` forever. Two common ways that happens:
//
//  1. Enabling tracking while disengaged. "Start" recenters the cursor by
//     teleporting it to the screen center - but that teleport is ASYNC, and
//     the unpause itself starts streaming renderer moves immediately, so the
//     first blocked frame captured the anchor at the PRE-teleport position.
//     offset became (center - old position) and stayed there.
//  2. Physically moving the mouse while parked.
//
// Why that matters: the renderer clamps ITS OWN coordinates to the screen,
// but the main process applies `internal - offset` WITHOUT re-clamping. With
// a poisoned offset, the reachable real range is shifted by (old position -
// center): the cursor hits an invisible wall near the top or bottom edge
// (depending on where the cursor was when tracking started) and the resting
// center is no longer the screen center. Saying the park word ("静止") and
// resuming ("移动") re-pins the renderer onto the real cursor, which decays
// the offset back to ~0 - which is why that was the only recovery.
//
// THE FIX: re-anchor against the CURRENT real cursor on EVERY blocked frame.
// The renderer is pinned to the same cursor, so the offset stays ~0 while
// parked and re-engaging continues from where the cursor actually is - which
// is also exactly what the original design comment always promised ("pinned
// back onto the real cursor, so that re-engaging continues from where the
// cursor actually is instead of jumping"). The stale-anchor case can no
// longer survive a whole parked period, let alone poison the mapping.

/**
 * Creates the clutch state machine.
 * @param {object} deps
 * @param {() => boolean} deps.isEnabled whether the main clutch is on in settings
 * @param {() => boolean} deps.isEngaged whether movement is currently allowed
 *   (key held / toggle on / spoken override)
 * @param {(curPos: {x: number, y: number}) => void} [deps.onPin] called while
 *   disengaged so the caller can pin the renderer pointer onto the real cursor
 * @returns {{
 *   apply: (x: number, y: number, curPos: {x: number, y: number}) =>
 *     {x: number, y: number, blocked: boolean},
 *   reset: () => void,
 *   isBlocked: () => boolean,
 * }}
 * NOTE: this module is loaded from the Electron MAIN process with a plain
 * CommonJS `require()`. Electron's bundled Node (20.x in Tracky Mouse 3.1.0)
 * does not support `require()` of ES modules, so this file MUST stay
 * CommonJS (`module.exports`). Using `export` here made the app fail to
 * start (ERR_REQUIRE_ESM) in v50.0.
 */
function createCursorClutch({ isEnabled, isEngaged, onPin } = {}) {
	let blocked = false;
	let anchor = null; // kept for diagnostics; re-anchored every blocked frame
	let offset = { x: 0, y: 0 };

	/**
	 * One mouse-move frame.
	 * @param {number} x head-tracked target x (CSS px, virtual desktop)
	 * @param {number} y head-tracked target y
	 * @param {{x: number, y: number}} curPos current REAL cursor position
	 */
	function apply(x, y, curPos) {
		if (!isEnabled()) {
			// Clutch turned off: behave exactly like the stock app.
			reset();
			return { x, y, blocked: false };
		}
		const blocking = !isEngaged();
		if (blocking) {
			// v50: re-anchor to the CURRENT real cursor every blocked frame
			// (was: only on the first blocked frame). The renderer pointer is
			// pinned to the same cursor, so this keeps the stitch offset at
			// ~0 while parked and self-heals any stale anchor (enable
			// teleport races, physical mouse movement) within one frame.
			blocked = true;
			anchor = { x: curPos.x, y: curPos.y };
			offset = { x: x - anchor.x, y: y - anchor.y };
			onPin?.(curPos);
			return { x, y, blocked: true };
		}
		if (blocked) {
			// Just re-engaged: the offset from the last blocked frame maps
			// this frame onto the real cursor, so movement continues from
			// where the cursor actually is (not from some stale anchor).
			blocked = false;
		}
		return {
			x: Math.round(x - offset.x),
			y: Math.round(y - offset.y),
			blocked: false,
		};
	}

	function reset() {
		blocked = false;
		anchor = null;
		offset = { x: 0, y: 0 };
	}

	return { apply, reset, isBlocked: () => blocked };
}

/**
 * The OLD algorithm, kept only for the regression test: with a frozen anchor
 * the offset survives whatever moved the real cursor during the parked
 * period, and the reachable range comes out shifted. Exported so the unit
 * tests can demonstrate that the old behavior produces the "invisible wall"
 * and the new one does not (negative control).
 */
function legacyFrozenAnchorApply(state, x, y, curPos, engaged) {
	if (!engaged) {
		if (!state.blocked || !state.anchor) {
			state.anchor = { x: curPos.x, y: curPos.y };
		}
		state.blocked = true;
		state.offset = { x: x - state.anchor.x, y: y - state.anchor.y };
		return { x, y, blocked: true };
	}
	state.blocked = false;
	return {
		x: Math.round(x - state.offset.x),
		y: Math.round(y - state.offset.y),
		blocked: false,
	};
}

module.exports = { createCursorClutch, legacyFrozenAnchorApply };
