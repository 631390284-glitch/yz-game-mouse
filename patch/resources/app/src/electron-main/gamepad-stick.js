// Virtual gamepad stick output for head tracking (added feature).
//
// Spawns tracky-vigem-stick.exe (see tools/tracky-vigem-stick/), which creates
// a virtual Xbox 360 gamepad via ViGEmClient.dll / the ViGEmBus driver. Head
// movement can be mapped onto its LEFT stick (character movement) and/or its
// RIGHT stick (3D game camera), each gated by its own clutch key.
//
// Protocol (one line per update on stdin):
//   "lx ly rx ry"    raw stick units, screen convention (+x right, +y down)
//   "keymap <json>"  Joy-Con button → keyboard/mouse mappings (Joy-To-Key)
//   "bridge 0|1"     Joy-Con → virtual pad bridging (real controller input
//                    takes over the pad while it's active)
//   "grip <mode>"    how single Joy-Cons are held: "vertical" (upright or in
//                    a charging grip; no rotation) or "horizontal" (sideways;
//                    L rotated 90° CCW, R 90° CW)
//   "pulse 0|1"      stick pulses on/off
//   "zones <json>"   head-touch zone → key table ([{id, key}])
//   "zone <id> 1|0"  head entered / left touch zone <id>
//
// The exe requires ViGEmBus (kernel driver) + ViGEmClient.dll next to it.
// If either is missing the exe exits immediately; we log once and keep
// running (the app works, the sticks just don't do anything).

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const EXE_NAME = process.platform === 'win32' ? 'tracky-vigem-stick.exe' : 'tracky-vigem-stick';

/** @type {import('child_process').ChildProcessWithoutNullStreams | null} */
let stickProcess = null;
let appRef = null;
let restartTimer = null;
let missingDependencyLogged = false;
// Whether the helper should nudge the sticks to make games notice the pad.
let lastPulseEnabled = true;
// v31: whether the running helper was started WITH the virtual pad. When game
// mode is off the helper still runs (mouse-mode blink / mouth clicks press
// keys through it) but is started with "--no-pad --no-joycon", so Windows never
// sees a controller appear at launch nor disappear at quit - which is what made
// the system stall while re-scanning devices.
let lastSpawnWithPad = null;

function candidatePaths(app) {
	const candidates = [];
	if (app.isPackaged) {
		candidates.push(path.join(process.resourcesPath, 'bin', EXE_NAME));
	}
	candidates.push(path.join(app.getAppPath(), 'bin', EXE_NAME));
	candidates.push(path.join(app.getAppPath(), 'tm-driver', 'bin', EXE_NAME));
	return candidates;
}

function findExePath() {
	if (!appRef) {
		return null;
	}
	return candidatePaths(appRef).find((candidate) => fs.existsSync(candidate)) ?? null;
}

function scheduleRestart() {
	clearTimeout(restartTimer);
	restartTimer = setTimeout(() => {
		if (!stickProcess && appRef) {
			// Keep the mode the helper was running in (pad vs. no-pad).
			startGamepadStick({ app: appRef, withPad: lastSpawnWithPad !== false });
		}
	}, 2000);
}

/**
 * Starts the helper, or restarts it when the requested pad mode differs.
 *
 * @param {object}  [options]
 * @param {object}  [options.app]     Electron app (for finding the executable).
 * @param {boolean} [options.withPad] true: create the virtual Xbox 360 pad
 *   (game mode). false: run headless - Joy-To-Key / touch-zone / gesture keys
 *   are still injected, but no controller is created and Joy-Con HID reading is
 *   off (mouse mode).
 * @returns {boolean} true only when a NEW helper was spawned.
 */
function startGamepadStick({ app, withPad = true } = {}) {
	appRef = app ?? appRef;
	if (stickProcess) {
		if (lastSpawnWithPad === withPad) {
			return false;
		}
		// Mode change (e.g. leaving game mode): restart without the pad. The
		// stop below clears `stickProcess` first, so the old process's exit
		// handler won't schedule a restart.
		stopGamepadStick();
	}
	if (!appRef) {
		console.error('[gamepad-stick] no app reference; cannot find helper executable.');
		return false;
	}
	const exePath = findExePath();
	if (!exePath) {
		console.error(`[gamepad-stick] ${EXE_NAME} not found; virtual gamepad sticks are not available.`);
		return false;
	}
	const args = withPad ? [] : ['--no-pad', '--no-joycon'];
	let proc;
	try {
		proc = spawn(exePath, args, {
			stdio: ['pipe', 'ignore', 'pipe'],
			windowsHide: true,
		});
	} catch (error) {
		console.error('[gamepad-stick] failed to spawn helper:', error);
		return false;
	}
	stickProcess = proc;
	lastSpawnWithPad = withPad;
	appendLog(`helper started (${exePath}${withPad ? '' : ', without virtual pad'})`);
	// Push the last known key mappings so a freshly spawned helper is in sync.
	if (lastKeymapConfig) {
		writeKeymapConfigLines(proc, lastKeymapConfig);
	}
	if (lastZonesConfig) {
		writeZonesConfigLine(proc, lastZonesConfig);
	}
	writePulseConfigLine(proc, lastPulseEnabled);
	writeGripLine(proc, lastGripMode);
	writeBridgeLine(proc, lastBridgeEnabled);
	writeStickGateLine(proc, lastStickGateEnabled);
	proc.on('error', (error) => {
		console.error('[gamepad-stick] helper error:', error);
		appendLog(`helper error: ${error.message}`);
	});
	proc.stderr.on('data', (chunk) => {
		const text = chunk.toString().trimEnd();
		if (!text) {
			return;
		}
		console.error(`[gamepad-stick] ${text}`);
		appendLog(text);
		if (missingDependencyLogged === false && /ViGEmClient\.dll|ViGEmBus/.test(text)) {
			missingDependencyLogged = true;
		}
	});
	proc.on('exit', (code, signal) => {
		appendLog(`helper exited (code=${code}, signal=${signal ?? 'none'})`);
		if (stickProcess === proc) {
			// Exited on its own (not stopped by us): restart.
			stickProcess = null;
			try {
				proc.stdin.end();
			} catch {
				// already closed
			}
			console.warn(`[gamepad-stick] helper exited (code=${code}, signal=${signal ?? 'none'}); restarting.`);
			scheduleRestart();
		}
	});
	return true;
}

// --- Diagnostic log ---------------------------------------------------------
// The helper's stderr is the only place that says whether ViGEm connected, the
// pad was created, and when pulses fire. Electron's console is invisible in a
// packaged app, so mirror it to a small rotating file next to the settings -
// that's what makes "it works in Steam but not in the game" debuggable.

const LOG_MAX_BYTES = 512 * 1024;
let logFilePath = null;

function helperLogPath() {
	if (logFilePath) {
		return logFilePath;
	}
	try {
		logFilePath = path.join(appRef.getPath('userData'), 'tracky-vigem-stick.log');
	} catch {
		logFilePath = null;
	}
	return logFilePath;
}

function appendLog(text) {
	const file = helperLogPath();
	if (!file) {
		return;
	}
	try {
		if (fs.existsSync(file) && fs.statSync(file).size > LOG_MAX_BYTES) {
			try {
				fs.unlinkSync(`${file}.1`);
			} catch {
				// no previous rotation to remove
			}
			fs.renameSync(file, `${file}.1`);
		}
		fs.appendFileSync(file, `${new Date().toISOString()} ${text}\n`);
	} catch {
		// logging must never break the feature
	}
}

/**
 * Appends an app-side event to the same diagnostic log the helper writes to,
 * so "the bridge / the sticks do nothing" can be debugged from one file even
 * when Electron's own console is invisible in a packaged app.
 */
function logHelperEvent(text) {
	appendLog(`[app] ${text}`);
}

// --- Stick pulse ------------------------------------------------------------
// A freshly created virtual pad can be ignored by games (and swallowed by Steam
// Input's "Xbox configuration") until it shows activity. The helper can nudge
// both sticks for a few frames when the pad appears and when the foreground
// window changes, which is when games re-scan controllers.
function writePulseConfigLine(proc, enabled) {
	proc.stdin.write(`pulse ${enabled ? 1 : 0}\n`);
}

function sendPulseConfig(enabled) {
	lastPulseEnabled = enabled !== false;
	const proc = stickProcess;
	if (!proc || !proc.stdin || proc.stdin.destroyed || !proc.stdin.writable) {
		return;
	}
	try {
		writePulseConfigLine(proc, lastPulseEnabled);
	} catch (error) {
		console.error('[gamepad-stick] failed to send pulse config:', error);
	}
}

/**
 * Sets both virtual sticks at once (screen convention: +x right, +y down).
 * Values are clamped to [-32768, 32767] by the helper.
 */
function sendGamepadSticks(lx, ly, rx, ry) {
	const proc = stickProcess;
	if (!proc || !proc.stdin || proc.stdin.destroyed || !proc.stdin.writable) {
		return;
	}
	proc.stdin.write(`${lx} ${ly} ${rx} ${ry}\n`);
}

// Joy-Con → virtual pad bridge (added feature): forwarded to the helper over
// stdin so it stays hot-updatable. While engaged, real Joy-Con input takes
// over the pad whenever the controllers are actively used.
let lastBridgeEnabled = false;

function writeBridgeLine(proc, enabled) {
	proc.stdin.write(`bridge ${enabled ? 1 : 0}\n`);
}

function sendBridgeEnabled(enabled) {
	lastBridgeEnabled = enabled === true;
	const proc = stickProcess;
	if (!proc || !proc.stdin || proc.stdin.destroyed || !proc.stdin.writable) {
		return;
	}
	try {
		writeBridgeLine(proc, lastBridgeEnabled);
	} catch (error) {
		console.error('[gamepad-stick] failed to send bridge config:', error);
	}
}

// Desktop stick→key mapping gate (added feature): forwarded over stdin so it
// stays hot-updatable. When the gate is closed the helper blocks (and
// releases) all stick-direction mappings; regular button mappings are
// unaffected.
let lastStickGateEnabled = false;

function writeStickGateLine(proc, enabled) {
	proc.stdin.write(`stickgate ${enabled ? 1 : 0}\n`);
}

function sendStickGate(enabled) {
	lastStickGateEnabled = enabled === true;
	const proc = stickProcess;
	if (!proc || !proc.stdin || proc.stdin.destroyed || !proc.stdin.writable) {
		return;
	}
	try {
		writeStickGateLine(proc, lastStickGateEnabled);
	} catch (error) {
		console.error('[gamepad-stick] failed to send stick gate config:', error);
	}
}

// How single Joy-Cons are held (added in v23): "vertical" (upright, or both
// halves in a charging grip - the controller's native orientation, which is
// also what the physical grip controller uses) or "horizontal" (the classic
// one-hand sideways grip, which rotates L 90° CCW and R 90° CW).
let lastGripMode = 'vertical';

function writeGripLine(proc, mode) {
	proc.stdin.write(`grip ${mode === 'horizontal' ? 'horizontal' : 'vertical'}\n`);
}

function sendGripConfig(mode) {
	lastGripMode = mode === 'horizontal' ? 'horizontal' : 'vertical';
	const proc = stickProcess;
	if (!proc || !proc.stdin || proc.stdin.destroyed || !proc.stdin.writable) {
		return;
	}
	try {
		writeGripLine(proc, lastGripMode);
	} catch (error) {
		console.error('[gamepad-stick] failed to send grip config:', error);
	}
}

// Joy-Con key mapping configuration (added feature): forwarded to the helper
// over stdin so it stays hot-updatable.
// Config: { keymapEnabled, keymap: [{btn, key}] }
let lastKeymapConfig = null;
let lastKeymapConfigJson = null;

function writeKeymapConfigLines(proc, cfg) {
	const keymap = cfg.keymapEnabled === false ? [] : (cfg.keymap || []);
	proc.stdin.write(`keymap ${JSON.stringify(keymap)}\n`);
}

function sendGamepadConfig(cfg) {
	const json = JSON.stringify(cfg);
	// The helper releases held keys whenever the table is replaced, so only
	// send it when it actually changed (setOptions fires for every setting).
	if (json === lastKeymapConfigJson) {
		return;
	}
	lastKeymapConfigJson = json;
	lastKeymapConfig = cfg;
	const proc = stickProcess;
	if (!proc || !proc.stdin || proc.stdin.destroyed || !proc.stdin.writable) {
		return;
	}
	try {
		writeKeymapConfigLines(proc, cfg);
	} catch (error) {
		console.error('[gamepad-stick] failed to send key mapping config:', error);
	}
}

// Head-touch zones (added feature): zone id → key table plus per-zone
// press/release edges, forwarded over stdin. Config: [{id, key}].
let lastZonesConfig = null;
let lastZonesConfigJson = null;

function writeZonesConfigLine(proc, zones) {
	proc.stdin.write(`zones ${JSON.stringify(zones || [])}\n`);
}

function sendGamepadZones(zones) {
	const list = Array.isArray(zones) ? zones : [];
	const json = JSON.stringify(list);
	if (json === lastZonesConfigJson) {
		return;
	}
	lastZonesConfigJson = json;
	lastZonesConfig = list;
	const proc = stickProcess;
	if (!proc || !proc.stdin || proc.stdin.destroyed || !proc.stdin.writable) {
		return;
	}
	try {
		writeZonesConfigLine(proc, list);
	} catch (error) {
		console.error('[gamepad-stick] failed to send touch zone config:', error);
	}
}

function sendGamepadZoneState(id, down) {
	const proc = stickProcess;
	if (!proc || !proc.stdin || proc.stdin.destroyed || !proc.stdin.writable) {
		return;
	}
	try {
		proc.stdin.write(`zone ${id} ${down ? 1 : 0}\n`);
	} catch (error) {
		console.error('[gamepad-stick] failed to send touch zone state:', error);
	}
}

/**
 * Runs the helper's self test: both sticks sweep for `seconds`, so the pad can
 * be verified with an external tool (browser gamepad tester, Steam, joy.cpl)
 * while the app is not driving the sticks. Returns the helper's log.
 */
function runStickSelfTest({ app, seconds = 15 } = {}) {
	appRef = app ?? appRef;
	return new Promise((resolve) => {
		if (!appRef) {
			resolve({ ok: false, log: 'no app reference; cannot find helper executable.' });
			return;
		}
		const exePath = findExePath();
		if (!exePath) {
			resolve({ ok: false, log: `${EXE_NAME} not found.` });
			return;
		}
		let log = '';
		let proc;
		try {
			proc = spawn(exePath, [`--test=${seconds}`], {
				stdio: ['ignore', 'ignore', 'pipe'],
				windowsHide: true,
			});
		} catch (error) {
			resolve({ ok: false, log: String(error?.message ?? error) });
			return;
		}
		appendLog(`self test started (${seconds}s)`);
		proc.stderr.on('data', (chunk) => {
			log += chunk.toString();
		});
		const timer = setTimeout(() => {
			try {
				proc.kill();
			} catch {
				// already gone
			}
		}, (seconds + 10) * 1000);
		proc.on('error', (error) => {
			clearTimeout(timer);
			resolve({ ok: false, log: `${log}${error.message}` });
		});
		proc.on('exit', (code) => {
			clearTimeout(timer);
			appendLog(`self test finished (code=${code})`);
			resolve({ ok: code === 0, log: log.trim() });
		});
	});
}

/** Stops the helper (removes the virtual pad; games treat the sticks as centered). */
function stopGamepadStick({ force = false } = {}) {
	clearTimeout(restartTimer);
	const proc = stickProcess;
	stickProcess = null;
	lastSpawnWithPad = null;
	if (proc) {
		try {
			proc.stdin.end();
		} catch {
			// already closed
		}
		// Graceful stop (v31): on stdin EOF the helper releases every key it
		// holds and removes the virtual pad by itself. Killing it outright can
		// drop the last "zone ... 0" / key-up still in the pipe, which would
		// leave a key stuck in Windows - and skipping the pad removal is what
		// made the system stall. Give it a moment, then insist.
		if (force) {
			// Quitting: Electron is about to go away, so there is no time for
			// a graceful exit (and a helper left behind would keep its pad).
			try {
				proc.kill();
			} catch {
				// already dead
			}
			return;
		}
		const killTimer = setTimeout(() => {
			try {
				proc.kill();
			} catch {
				// already dead
			}
		}, 600);
		proc.once('exit', () => clearTimeout(killTimer));
	}
}

function isGamepadStickRunning() {
	return stickProcess !== null;
}

module.exports = {
	startGamepadStick,
	stopGamepadStick,
	sendGamepadSticks,
	sendGamepadConfig,
	sendPulseConfig,
	sendGripConfig,
	sendBridgeEnabled,
	sendStickGate,
	sendGamepadZones,
	sendGamepadZoneState,
	logHelperEvent,
	isGamepadStickRunning,
	runStickSelfTest,
	EXE_NAME,
};
