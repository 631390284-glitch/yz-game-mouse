// Voice key hold (added feature, v43).
//
// Spoken keys ("左"/"右"/"中") with HOLD semantics built on a discrete
// keyword spotter: the spotter fires once per recognized segment, so a
// CONTINUOUS "左——" produces repeated hits every few hundred milliseconds.
// Each hit (re)arms a hold window for its slot; while the window is armed
// the bound keys stay pressed, and when the hits stop arriving the window
// expires and the keys release. A single short utterance behaves like a
// tap (press for ~holdMs), talking continuously holds the key for as long
// as the speech lasts (plus the tail).
//
// Pure state logic - no Electron imports - so it can be unit tested outside
// the app (same contract as voice-clutch.js / calibration-recenter.js).
//
// Note on recognition: a single-syllable word ("左") is at the edge of what
// the KWS model can spot - the detector reliably fires on CONTINUOUS or
// doubled speech ("左——", "左左"), which is exactly the intended usage
// (hold a key while saying the word). This is why the hold-window design
// (re-arm on every hit) is the right shape for this feature.

// How long the key stays pressed after the last recognized hit: long enough
// to bridge the gap between two detections during continuous speech
// (detections arrive every ~300-500 ms), short enough that the tail after
// stopping feels like a release, not a delay.
const DEFAULT_HOLD_MS = 800;

// v43 (hold semantics): while a slot is armed, ANY ongoing voice energy
// (cheap RMS gate on the mic stream - see voice-control.js) keeps the key
// pressed, so a sustained "左——" holds the key without the keyword spotter
// having to fire again (it often won't on a held vowel). Each active chunk
// pushes the release point SPEECH_EXTEND_MS into the future.
const DEFAULT_SPEECH_EXTEND_MS = 350;

// …but only for a while after the last actual hit: one spoken "左" inside
// flowing speech can't hold a key down forever.
const DEFAULT_SPEECH_CAP_MS = 4000;

// v45 (tap semantics): when tap mode is on, a keyword hit produces a single
// short click - the key presses for TAP_MS and releases, with no hold
// window and no speech-energy extension. "只要听到就点击一下": the word does
// not have to be sustained (the single-syllable edge cases of the KWS model
// matter much less), repeated words ("左，左，左") produce repeated clicks.
const DEFAULT_TAP_MS = 100;

/**
 * @param {object} [deps]
 * @param {number} [deps.holdMs] hold window per keyword hit (default 800)
 * @param {number} [deps.speechExtendMs] extension per voiced chunk (default 350)
 * @param {number} [deps.speechCapMs] max time after the last hit that speech
 *        may keep extending the window (default 4000)
 * @param {number} [deps.tapMs] click duration in tap mode (default 100)
 * @param {(line: string) => void} [deps.log]
 */
function createVoiceKeyHold({
	holdMs = DEFAULT_HOLD_MS,
	speechExtendMs = DEFAULT_SPEECH_EXTEND_MS,
	speechCapMs = DEFAULT_SPEECH_CAP_MS,
	tapMs = DEFAULT_TAP_MS,
	log = () => {},
} = {}) {
	// slot id → { down: boolean, until: number, lastHit: number }
	const slots = new Map();

	// v45: false = hold semantics (default, v43), true = tap semantics.
	let tapMode = false;

	/** Switches between hold (false) and tap (true) semantics (v45). */
	function setTapMode(enabled) {
		tapMode = enabled === true;
	}

	/**
	 * (Re)arms the hold window for a slot - a keyword hit. Returns true when
	 * this is a fresh PRESS edge (the key was up and now went down), false
	 * when it merely extends an already-pressed window.
	 * @param {string} slot "v1" | "v2" | "v3"
	 * @param {number} now current time (ms)
	 */
	function press(slot, now) {
		const s = slots.get(slot) || { down: false, until: 0, lastHit: 0 };
		const wasDown = s.down;
		s.down = true;
		// v45: in tap mode the window is a fixed short click, NOT a re-armed
		// hold - repeated hits arriving later each produce their own click.
		s.until = tapMode ? now + tapMs : Math.max(s.until, now + holdMs);
		s.lastHit = now;
		slots.set(slot, s);
		if (!wasDown) {
			log(`voice key: "${slot}" down`);
		}
		return !wasDown;
	}

	/**
	 * Extends an ARMED slot's window while voice energy is ongoing (a held
	 * vowel or flowing speech). Does nothing when the slot is up, and stops
	 * extending speechCapMs after the last real hit. v45: no-ops in tap mode
	 * (a click is a click - ongoing speech must not stretch it).
	 * @param {string} slot "v1" | "v2" | "v3"
	 * @param {number} now current time (ms)
	 */
	function extend(slot, now) {
		if (tapMode) {
			return;
		}
		const s = slots.get(slot);
		if (!s || !s.down) {
			return;
		}
		if (now - s.lastHit > speechCapMs) {
			return;
		}
		s.until = Math.max(s.until, now + speechExtendMs);
	}

	/**
	 * Expires windows whose last hit is too long ago.
	 * @param {number} now current time (ms)
	 * @returns {string[]} slot ids that RELEASED on this tick (edges)
	 */
	function tick(now) {
		const released = [];
		for (const [slot, s] of slots) {
			if (s.down && now >= s.until) {
				s.down = false;
				released.push(slot);
				log(`voice key: "${slot}" up`);
			}
		}
		return released;
	}

	/**
	 * Releases everything immediately (voice control switched off, slot
	 * disabled, helper table swapped…).
	 * @returns {string[]} slot ids that were down and got released
	 */
	function releaseAll() {
		const released = [];
		for (const [slot, s] of slots) {
			if (s.down) {
				s.down = false;
				released.push(slot);
				log(`voice key: "${slot}" up (released)`);
			}
		}
		return released;
	}

	/** @returns {boolean} whether the slot's keys are currently pressed */
	function isDown(slot) {
		return slots.get(slot)?.down === true;
	}

	return {
		press,
		extend,
		setTapMode,
		tick,
		releaseAll,
		isDown,
		_state: () => Object.fromEntries([...slots].map(([k, v]) => [k, { ...v }])),
	};
}

module.exports = { createVoiceKeyHold, DEFAULT_HOLD_MS, DEFAULT_SPEECH_EXTEND_MS, DEFAULT_SPEECH_CAP_MS, DEFAULT_TAP_MS };
