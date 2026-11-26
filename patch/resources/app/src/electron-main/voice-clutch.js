// Voice → clutch linkage (added feature, v38).
//
// The voice switches (v36) flipped the settings checkboxes, but the features
// they enable are ALSO gated by clutches: cursor movement by the main clutch,
// mouth clicking by the second clutch, blink clicking by the third clutch. So
// saying "张嘴" enabled mouth clicking in the UI while the second clutch key
// still had to be pressed before any click actually fired - the spoken switch
// and the clutch were two disconnected gates.
//
// This module closes that gap: every recognized voice command also engages
// ("on") or disengages ("off") the matching clutch, so speech alone is enough.
// The override lasts until the user touches the physical clutch key again -
// any press/release edge of that key hands control back to the hardware, so
// voice can never permanently overrule a deliberate key press.
//
// A clutch that is disabled in settings is never overridden (its gate is
// hard-wired open/closed by the main module regardless), and unknown commands
// are ignored. Pure state logic - no Electron imports - so it can be unit
// tested outside the app.

// Which clutch each voice command drives. The movement commands cover both
// the scheme pair ("开启"/"关闭" etc.) and the "移动"/"静止" switch.
const COMMAND_TO_CLUTCH = {
	movement: "main",
	blink: "third",
	mouth: "second",
};

const CLUTCH_IDS = ["main", "second", "third"];

/** Whether the clutch is switched on in settings at all (only then can voice
 * commands override it). Mirrors the gating conditions in electron-main.js. */
function clutchEnabledBySettings(which, settings = {}) {
	if (which === "main") {
		return settings.requireLeftButtonToMove !== false;
	}
	if (which === "second") {
		return settings.secondClutch !== false;
	}
	return settings.thirdClutch === true;
}

/**
 * @param {object} deps
 * @param {(line: string) => void} [deps.log]
 */
function createVoiceClutch({ log = () => {} } = {}) {
	// null = follow the physical key state; true/false = forced by voice.
	/** @type {{main: boolean|null, second: boolean|null, third: boolean|null}} */
	let overrides = { main: null, second: null, third: null };

	/**
	 * Applies a recognized voice command to its clutch.
	 * @param {string} command "movement" | "blink" | "mouth"
	 * @param {string} action "on" | "off"
	 * @param {object} [settings] current active settings
	 * @returns {{clutch: string, engaged: boolean, changed: boolean}|null}
	 *          null when the command doesn't map to a controllable clutch.
	 */
	function apply(command, action, settings = {}) {
		const which = COMMAND_TO_CLUTCH[command];
		if (!which) {
			return null;
		}
		if (!clutchEnabledBySettings(which, settings)) {
			return null;
		}
		const engaged = action === "on";
		const changed = overrides[which] !== engaged;
		overrides[which] = engaged;
		if (changed) {
			log(`voice clutch: ${which} ${engaged ? "engaged" : "disengaged"} by voice`);
		}
		return { clutch: which, engaged, changed };
	}

	/**
	 * Any physical key edge on a clutch clears its voice override, so the
	 * hardware is back in charge the moment the user touches the key.
	 * @param {string} which "main" | "second" | "third"
	 * @returns {boolean} true if an override was actually cleared.
	 */
	function onPhysicalKey(which) {
		if (overrides[which] !== null) {
			overrides[which] = null;
			log(`voice clutch: ${which} override cleared (physical key used)`);
			return true;
		}
		return false;
	}

	/**
	 * The gate used by the clutch state functions: the voice override wins
	 * while it exists, otherwise the physical state stands.
	 * @param {string} which "main" | "second" | "third"
	 * @param {boolean} baseEngaged what the physical key / toggle state says
	 */
	function gate(which, baseEngaged) {
		const override = overrides[which];
		return override === null ? baseEngaged : override;
	}

	/** Clears every override (used when voice control is switched off). */
	function reset() {
		overrides = { main: null, second: null, third: null };
	}

	return {
		apply,
		onPhysicalKey,
		gate,
		reset,
		_state: () => ({ ...overrides }),
	};
}

module.exports = { createVoiceClutch, clutchEnabledBySettings, COMMAND_TO_CLUTCH, CLUTCH_IDS };
