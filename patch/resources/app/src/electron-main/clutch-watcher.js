// Watches the physical state of configured "clutch" keys, so cursor movement
// can be gated on them.
//
// Windows has no JS/Node API for global button/key state, so we run a tiny
// helper executable (tracky-key-watch.exe, see tools/tracky-key-watch/) that
// polls GetAsyncKeyState / XInputGetState / winmm joysticks and prints "1"/"0"
// on change. It's a pure-Go binary (no cgo), spawned hidden, one line per
// state change.
//
// A key can be a mouse button ("mouse:left"), a keyboard virtual-key code
// ("vk:0xA2"), or a gamepad button ("gamepad:a"), as captured in the settings
// UI. setKeySpec() restarts the helper when the setting changes.
//
// createKeyWatcher() builds an independent watcher (its own helper process).
// Watchers used (added features):
// - clutchWatcher:            the main clutch - gates cursor movement on a key.
// - secondClutchWatcher:      the second clutch - facial clicking is off by
//                             default and only works while it's engaged (the
//                             cursor keeps following the head either way).
// - rightStickClutchWatcher:  gates head → virtual gamepad RIGHT stick.
// - touchZonesClutchWatcher:  gates the head-touch zone keys (camera pressure
//                             plates; see touch-zones.js in the renderer).
// - joyconBridgeClutchWatcher: gates Joy-Con → virtual gamepad bridging.
//                             While it's engaged, real Joy-Con input takes
//                             over the virtual pad whenever the controllers
//                             are actively used.

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const readline = require('readline');

const EXE_NAME = process.platform === 'win32' ? 'tracky-key-watch.exe' : 'tracky-key-watch';

const DEFAULT_KEY_SPEC = 'mouse:left';
const SECOND_DEFAULT_KEY_SPEC = 'mouse:x2';
const RIGHT_STICK_DEFAULT_KEY_SPEC = 'gamepad:rb';
const TOUCH_ZONES_DEFAULT_KEY_SPEC = 'mouse:x2';
// Third clutch (added feature, v28): gates the blink click (default off).
const THIRD_DEFAULT_KEY_SPEC = 'mouse:x1';

function candidatePaths(app) {
	const candidates = [];
	if (app.isPackaged) {
		candidates.push(path.join(process.resourcesPath, 'bin', EXE_NAME));
	}
	candidates.push(path.join(app.getAppPath(), 'bin', EXE_NAME));
	candidates.push(path.join(app.getAppPath(), 'tm-driver', 'bin', EXE_NAME));
	return candidates;
}

/**
 * Builds an independent key-state watcher with its own helper process.
 * @param {string} label used for log prefixes
 */
function createKeyWatcher(label) {
	const logPrefix = `[clutch-watcher:${label}]`;
	/** @type {import('child_process').ChildProcessWithoutNullStreams | null} */
	let watcherProcess = null;
	/** True when the helper is running and has reported at least one state. */
	let watcherReady = false;
	/** Last known physical state of the watched key. */
	let keyHeld = true; // fail open: if we can't tell, don't freeze the cursor
	/** The key spec the current helper process is watching. */
	let currentKeySpec = DEFAULT_KEY_SPEC;
	/** @type {Array<(down: boolean) => void>} */
	let stateChangeListeners = [];
	let appRef = null;
	let stopping = false;
	let restartTimeout = null;

	function scheduleRestart() {
		if (stopping) {
			return;
		}
		clearTimeout(restartTimeout);
		restartTimeout = setTimeout(() => {
			if (!stopping && !watcherProcess) {
				start({ app: appRef });
			}
		}, 2000);
	}

	function start({ app, keySpec } = {}) {
		appRef = app ?? appRef;
		if (keySpec) {
			currentKeySpec = keySpec;
		}
		stopping = false;
		if (watcherProcess) {
			return;
		}
		if (!appRef) {
			console.error(`${logPrefix} no app reference; cannot find helper executable.`);
			return;
		}
		const exePath = candidatePaths(appRef).find((candidate) => fs.existsSync(candidate));
		if (!exePath) {
			console.error(`${logPrefix} ${EXE_NAME} not found. Clutch mode will not be available.`);
			return;
		}
		let proc;
		try {
			proc = spawn(exePath, ['--key', currentKeySpec], {
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true,
			});
		} catch (error) {
			console.error(`${logPrefix} failed to spawn helper:`, error);
			return;
		}
		watcherProcess = proc;

		const lineReader = readline.createInterface({ input: proc.stdout });
		lineReader.on('line', (line) => {
			const value = line.trim();
			let down;
			if (value === '1') {
				down = true;
			} else if (value === '0') {
				down = false;
			} else {
				return;
			}
			const changed = keyHeld !== down;
			keyHeld = down;
			watcherReady = true;
			if (changed) {
				for (const listener of [...stateChangeListeners]) {
					try {
						listener(down);
					} catch (error) {
						console.error(`${logPrefix} error in state change listener:`, error);
					}
				}
			}
		});
		proc.stderr.on('data', (chunk) => {
			const text = chunk.toString().trimEnd();
			if (text) {
				console.error(`${logPrefix} ${text}`);
			}
		});
		proc.on('error', (error) => {
			console.error(`${logPrefix} helper error:`, error);
		});
		proc.on('exit', (code, signal) => {
			if (watcherProcess === proc) {
				watcherProcess = null;
				watcherReady = false;
				keyHeld = true; // fail open until we hear from a new instance
				if (!stopping) {
					console.warn(`${logPrefix} helper exited (code=${code}, signal=${signal ?? 'none'}); restarting.`);
					scheduleRestart();
				}
			}
		});
	}

	function stop() {
		stopping = true;
		clearTimeout(restartTimeout);
		if (watcherProcess) {
			const proc = watcherProcess;
			watcherProcess = null;
			proc.kill();
		}
		watcherReady = false;
		keyHeld = true;
	}

	/**
	 * Switches to watching a different key. Restarts the helper process.
	 * @param {string} keySpec e.g. "mouse:left", "vk:0xA2", "gamepad:a"
	 * @param {object} app Electron app object (optional after the first start)
	 */
	function setKeySpec(keySpec, app) {
		if (!keySpec || keySpec === currentKeySpec) {
			return;
		}
		currentKeySpec = keySpec;
		if (app) {
			appRef = app;
		}
		const proc = watcherProcess;
		watcherProcess = null;
		watcherReady = false;
		keyHeld = true; // fail open while restarting
		if (proc) {
			proc.kill();
		}
		// The exit handler of the old process won't schedule a restart because
		// `watcherProcess` is already set to a new process (or will be right away).
		start({ app: appRef });
	}

	/**
	 * @returns {boolean} true while the physical key is held down.
	 * Returns true when the helper isn't available, so the app never gets stuck.
	 */
	function isHeld() {
		return keyHeld;
	}

	function isReady() {
		return watcherReady;
	}

	/**
	 * Subscribe to key state changes (true = pressed down, false = released).
	 * Used for toggle mode: each press flips the movement on/off.
	 * @param {(down: boolean) => void} callback
	 * @returns {() => void} unsubscribe function
	 */
	function onStateChange(callback) {
		stateChangeListeners.push(callback);
		return () => {
			stateChangeListeners = stateChangeListeners.filter((listener) => listener !== callback);
		};
	}

	function getKeySpec() {
		return currentKeySpec;
	}

	return { start, stop, setKeySpec, isHeld, isReady, onStateChange, getKeySpec };
}

// The main clutch (original added feature): gate cursor movement on a key.
const clutchWatcher = createKeyWatcher('clutch');

// Backwards-compatible module-level API for the main clutch.
const startLMBWatcher = clutchWatcher.start;
const stopLMBWatcher = clutchWatcher.stop;
const setClutchKeySpec = clutchWatcher.setKeySpec;
const isClutchKeyHeld = clutchWatcher.isHeld;
const isLMBWatcherReady = clutchWatcher.isReady;
const onClutchKeyStateChange = clutchWatcher.onStateChange;
const getCurrentClutchKeySpec = clutchWatcher.getKeySpec;

// The second clutch (added feature): freezes facial clicking (e.g. while
// typing or reading) while the cursor keeps following the head.
const secondClutchWatcher = createKeyWatcher('second-clutch');

// The third clutch (added feature, v28): gates the blink click the same way
// the second clutch gates mouth clicking - blink clicking is off by default
// and only works while the third clutch is engaged.
const thirdClutchWatcher = createKeyWatcher('third-clutch');

// Head → virtual gamepad RIGHT stick (added feature). The left stick
// projection was replaced by the head-touch zones in v19.
const rightStickClutchWatcher = createKeyWatcher('right-stick');

// Head-touch zones clutch (added feature, v19): gates the camera pressure
// plates so zone keys only fire while the clutch allows it.
const touchZonesClutchWatcher = createKeyWatcher('touch-zones');

// Touch zones scheme 2 clutch (added feature, v22): touch zones are organized
// into two schemes, each with its own clutch, so the same camera spot can hold
// a scheme-1 plate (key A) and a scheme-2 plate (key B) and you switch layouts
// by engaging the matching clutch.
const touchZones2ClutchWatcher = createKeyWatcher('touch-zones-2');

// Touch zones exclusive-switch key (added feature, v25): while it's engaged,
// scheme 1 is suspended and scheme 2 takes over (and vice versa when
// released), regardless of each scheme's own clutch state.
const touchZonesExClutchWatcher = createKeyWatcher('touch-zones-ex');

// Joy-Con → virtual gamepad bridge (added feature): while engaged, real
// Joy-Con / Pro Controller input takes over the virtual pad whenever the
// controllers are actively used (idle controllers never block head tracking).
const joyconBridgeClutchWatcher = createKeyWatcher('joycon-bridge');

// Desktop stick→key mapping clutch (added feature): while it's engaged, the
// sticks' desktop-direction mappings (arrows, wheel, custom keys) may fire.
const stickDesktopClutchWatcher = createKeyWatcher('stick-desktop');

// --- Gamepad button capture (added feature) -----------------------------------
// The renderer's Gamepad API only sees Chromium-supported controllers, and the
// capture UI can't bind what Windows sees but Chromium doesn't. To cover
// DirectInput-class gamepads (PlayStation pads in DInput mode, many Bluetooth
// and generic USB pads), capture also runs the helper with --capture-gamepad,
// which polls XInput *and* the winmm joystick API.

/** @type {import('child_process').ChildProcessWithoutNullStreams | null} */
let captureProcess = null;
/** @type {(() => void) | null} */
let captureCleanup = null;
/** Electron app object last passed to captureClutchGamepad(). */
let captureAppRef = null;

/**
 * Captures the first pressed gamepad button via the helper executable.
 * Resolves with a key spec like "gamepad:a" or "gamepad:btn5", or null if
 * capture failed, was cancelled, or the helper isn't available.
 * @param {object} app Electron app object
 * @returns {Promise<string|null>}
 */
function captureClutchGamepad(app) {
	cancelClutchGamepadCapture();
	captureAppRef = app ?? captureAppRef;
	if (!captureAppRef) {
		return Promise.resolve(null);
	}
	const exePath = candidatePaths(captureAppRef).find((candidate) => fs.existsSync(candidate));
	if (!exePath) {
		return Promise.resolve(null);
	}
	return new Promise((resolve) => {
		let settled = false;
		const finish = (result) => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			resolve(result);
		};
		const cleanup = () => {
			captureProcess = null;
			captureCleanup = null;
		};
		let proc;
		try {
			proc = spawn(exePath, ['--capture-gamepad'], {
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true,
			});
		} catch (error) {
			console.error('[clutch-watcher] failed to spawn capture helper:', error);
			finish(null);
			return;
		}
		captureProcess = proc;
		let output = '';
		proc.stdout.on('data', (chunk) => {
			output += chunk.toString();
			const line = output.trim().split('\n')[0]?.trim();
			if (line && line.startsWith('gamepad:')) {
				finish(line);
			}
		});
		proc.stderr.on('data', () => {}); // diagnostics only
		proc.on('error', () => finish(null));
		proc.on('exit', () => {
			// Helper exits after printing a spec; if nothing was printed, treat as cancelled.
			const line = output.trim().split('\n')[0]?.trim();
			finish(line && line.startsWith('gamepad:') ? line : null);
		});
		captureCleanup = () => {
			// Cancel: kill the process; the exit handler resolves with null,
			// but the promise may already have been resolved by the caller.
			try {
				proc.kill();
			} catch {
				// already dead
			}
		};
	});
}

function cancelClutchGamepadCapture() {
	if (captureCleanup) {
		const cleanup = captureCleanup;
		cleanup();
	}
}

module.exports = {
	DEFAULT_KEY_SPEC,
	SECOND_DEFAULT_KEY_SPEC,
	THIRD_DEFAULT_KEY_SPEC,
	RIGHT_STICK_DEFAULT_KEY_SPEC,
	TOUCH_ZONES_DEFAULT_KEY_SPEC,
	createKeyWatcher,
	clutchWatcher,
	secondClutchWatcher,
	thirdClutchWatcher,
	rightStickClutchWatcher,
	touchZonesClutchWatcher,
	touchZones2ClutchWatcher,
	touchZonesExClutchWatcher,
	joyconBridgeClutchWatcher,
	stickDesktopClutchWatcher,
	startLMBWatcher,
	stopLMBWatcher,
	setClutchKeySpec,
	isClutchKeyHeld,
	isLMBWatcherReady,
	onClutchKeyStateChange,
	getCurrentClutchKeySpec,
	captureClutchGamepad,
	cancelClutchGamepadCapture,
};
