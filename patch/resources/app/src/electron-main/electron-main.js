
// Note: Don't require any third-party (or own) modules until after squirrel events are handled.
// If anything goes wrong, it's very bad for it to go wrong during installation and uninstallation!
// I'm making an exception for Sentry, since it could help track down installation issues.
const path = require('path');
const { app, globalShortcut, dialog, BrowserWindow, ipcMain, session, shell } = require('electron');
try {
	const Sentry = require("@sentry/electron/main");
	let sentryEnvironment = app.isPackaged ? "packaged" : "development";
	try {
		// Look for marker file in packaged app root
		const markerPath = path.join(process.resourcesPath, 'app/official-release.txt');
		if (require('fs').existsSync(markerPath)) {
			sentryEnvironment = "production";
		}
	} catch (error) {
		console.error("Error checking for official release marker file:", error);
	}
	Sentry.init({
		dsn: "https://d02619b2adf1ec1ea0c6219e5cbb6f0d@o4507120033660928.ingest.us.sentry.io/4510658749202432",
		environment: sentryEnvironment,
	});
	// Special handling for a very broken computer of mine
	// so hopefully I can filter out the crashes that it gets
	if (process.env.IS_BAD_COMPUTER === 'true') {
		Sentry.setTag("is_bad_computer", "true");
	}
} catch (error) {
	console.error("Error initializing Sentry:", error);
}


const fs = require('fs/promises');
const { handleStartupEvent } = require('./squirrel-update.js');

// TODO: is there any merit to app.quit when there are no windows open?

// Needed for run-at-login on Windows. This is used as the registry key name.
// Needs to be set early since `setLoginItemSettings` is used in the `--squirrel-uninstall` handler.
app.setAppUserModelId("io.isaiahodhner.tracky-mouse");

// Handle installing/uninstalling shortcuts and the CLI's PATH modification on Windows.
if (process.platform === 'win32') {
	const possibleSquirrelEventFlag = process.argv[1];
	if (handleStartupEvent(possibleSquirrelEventFlag)) {
		return;
	}
}

// From this point on, third party modules can be required now without risking interfering with the installer.

const { getVersion } = require('./version.js');
const { checkForUpdates } = require('./auto-updater.js');

// Compare command line arguments:
// - unpackaged (in development):      "path/to/electron.exe" "." "maybe/a/file.png"
// - packaged (usually in production): "path/to/jspaint.exe" "maybe/a/file.png"
const { isPackaged } = app;
const argsArray = process.argv.slice(isPackaged ? 1 : 2);

const settingsFile = path.join(app.getPath('userData'), 'tracky-mouse-settings.json');
const formatName = "tracky-mouse-settings";
const formatVersion = 1;

const { setLocale, getScreenOverlayMessageText } = require('./i18n.js');

// Load settings early for CLI localization
try {
	loadLanguageSettingSync();
} catch (error) {
	console.error("Error loading settings synchronously during startup:", error);
}

// File cli.js must be loaded after locale is loaded, with how it's set up right now.
const { parser } = require('./cli.js');

// Note: this may exit the app, if the user runs `tracky-mouse --help`.
const args = parser.parse_args(argsArray);

// After argument parsing that may have exited the app, handle single instance behavior.
// Electron provides a way to communicate between instances of the app,
// using a lock file to determine if the process is the primary instance.
// However, it only provides communication in one direction
// (from the second instance to the primary instance, via the "second-instance" event),
// so we have to implement communication the other way ourselves.

// This is used to communicate the output of a CLI command from the existing instance to the new instance.
// Could use an in-memory pipe, or HTTP, but this may be the simplest way.
const tempFilePath = path.join(app.getPath('temp'), `tracky-mouse-cli-output-${Date.now()}.txt`);

// Note: The "second-instance" event has an `argv` argument but it's unusably broken,
// and the documented workaround is to pass the arguments as `additionalData` here.
// https://www.electronjs.org/docs/api/app#event-second-instance
const gotSingleInstanceLock = app.requestSingleInstanceLock({
	// WARNING: key order and key length can cause this bug to crop up: https://github.com/electron/electron/issues/40615
	// For instance, naming this key "argv" instead of "arguments" can cause `additionalData` to be null when no arguments are passed.
	arguments: argsArray,
	tempFilePath,
});

// Note: If the main process crashes during the "second-instance" event, the second instance will get the lock,
// even if the first instance is still showing an error dialog.
if (!gotSingleInstanceLock) {
	// console.log("Already running. Opening in existing instance.");

	if (args.version) {
		// Special handling for --version: show versions of both instances.
		// TODO: might want to ditch the streaming below and read the whole file in order to COMPARE the versions,
		// and only show the version of the existing instance if it's different.
		// Or to format it differently. Right now it's constrained to outputting the existing instance as the last line.
		// Alternatively, I could pass the version into requestSingleInstanceLock (only if --version is passed, since it requires executing a git command),
		// and format the output in the existing instance's "second-instance" handler.
		// That would probably be cleaner, although it would be worse for error handling.
		console.log("CLI version:", getVersion());
		process.stdout.write("Running app's version: "); // avoid newline which would be added by console.log
	}

	// Proxy the output from the existing instance to the CLI command.
	(async () => {
		setTimeout(() => {
			if (args.version) {
				console.log("unknown");
			}
			console.error("Timed out waiting for file to exist:", tempFilePath);
			console.error("The already-running app is meant to write to this file with the output for the CLI command.");
			console.error("However, the app may have crashed or hung, or there may be a bug in the communication code.");
			app.exit(1);
		}, 10000);

		// Wait for file to exist.
		// (It may exist already, but we can't assume that.)
		const waitFor = (fn) => new Promise((resolve) => {
			const interval = setInterval(async () => {
				const result = await fn();
				if (result) {
					clearInterval(interval);
					resolve(result);
				}
			}, 100);
		});
		await waitFor(async () => fs.stat(tempFilePath).catch(() => null));
		// Stream the file to the new instance.
		// Note that this only avoids race conditions because the file is fully written before it's renamed and seen.
		// So using streaming here is not super meaningful.
		// (One could tail the file, but that would be more complex and I'm not sure you'd be able to tell when the file is closed without a sentinel value to mark the end of the stream.)
		const stream = require('fs').createReadStream(tempFilePath);
		stream.pipe(process.stdout);
		stream.on('close', () => {
			// Extra temp files will also be cleaned up on app startup, in case something goes wrong here.
			fs.unlink(tempFilePath).catch((error) => {
				console.error("Error deleting temp file:", error);
			}).finally(() => {
				app.quit();
			});
		});
		stream.on('error', (error) => {
			console.error("file stream error:", error);
			app.quit();
		});
	})();

	// app.quit();
	// `app.quit` does not immediately exit the process.
	// Return to avoid errors / main window briefly appearing.
	//   [52128:0304/194956.188:ERROR:cache_util_win.cc(20)] Unable to move the cache: Access is denied. (0x5)
	//   [52128:0304/194956.189:ERROR:cache_util.cc(145)] Unable to move cache folder C:\Users\Isaiah\AppData\Roaming\Electron\GPUCache to C:\Users\Isaiah\AppData\Roaming\Electron\old_GPUCache_000
	//   [52128:0304/194956.189:ERROR:disk_cache.cc(196)] Unable to create cache
	//   [52128:0304/194956.189:ERROR:shader_disk_cache.cc(613)] Shader Cache Creation failed: -2
	return;
} else {
	// console.log("Got single instance lock.");
	// When a second instance is opened, the "second-instance" event will be emitted in the this instance.
	// See handler below.
}

// Clean up temp files from previous runs.
// Only do this if the lock is acquired, so that multiple "second instances" can be handled in parallel, theoretically.
// (Otherwise one instance could delete the file before another instance reads it.)
// TODO: switch to a more inherently ephemeral communication method, like a pipe or a socket.
(async () => {
	try {
		for (const file of await fs.readdir(app.getPath('temp'))) {
			if (file.startsWith("tracky-mouse-cli-output-")) {
				await fs.unlink(path.join(app.getPath('temp'), file));
			}
		}
	} catch (error) {
		console.error("Error during temp file cleanup:", error);
	}
})();

// Handle --version in the basic case where the app is not already running.
if (args.version) {
	console.log(getVersion());
	app.quit();
	return;
}

// Exit for arguments that are not supported when the app is not already running.
// Some or all of these could be supported in the future.
// `--profile` seems useful; `--adjust` not so much.
const secondInstanceOnlyArgs = ["profile", "adjust", "set", "get", "start", "stop"];
if (secondInstanceOnlyArgs.some(arg => args[arg])) {
	const badArgs = secondInstanceOnlyArgs.filter(arg => args[arg]);
	const badArgsString = badArgs.map(arg => `--${arg}`).join(", ");
	if (badArgs.length === 1) {
		console.log(`The argument ${badArgsString} is only supported when the app is already running.`);
	} else {
		console.log(`These arguments are only supported when the app is already running: ${badArgsString}.`);
	}
	console.log("If you have a use case, please let me know by opening an issue at https://github.com/1j01/tracky-mouse/issues/new or sending an email to isaiahodhner@gmail.com");
	app.quit();
	return;
}

// Normal app behavior continues here.

const windowStateKeeper = require('electron-window-state');
const {
	startTMDriver,
	stopTMDriver,
	ensureCursorVisibility: ensureCursorVisibilityWithDriver,
	setMouseLocation: setMouseLocationWithoutTracking,
	moveMouseRelative: moveMouseRelativeWithoutTracking,
	getMouseLocation,
	click,
	mouseDown,
	mouseUp,
} = require('./tm-driver-client.js');
const screen = require('electron').screen; // Note: can't be used until ready event
const {
	DEFAULT_KEY_SPEC,
	SECOND_DEFAULT_KEY_SPEC,
	THIRD_DEFAULT_KEY_SPEC,
	RIGHT_STICK_DEFAULT_KEY_SPEC,
	TOUCH_ZONES_DEFAULT_KEY_SPEC,
	secondClutchWatcher,
	thirdClutchWatcher,
	rightStickClutchWatcher,
	joyconBridgeClutchWatcher,
	touchZonesClutchWatcher,
	touchZones2ClutchWatcher,
	touchZonesExClutchWatcher,
	stickDesktopClutchWatcher,
	startLMBWatcher,
	stopLMBWatcher,
	setClutchKeySpec,
	isClutchKeyHeld,
	onClutchKeyStateChange,
	captureClutchGamepad,
	cancelClutchGamepadCapture,
} = require('./clutch-watcher.js');
const {
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
} = require('./gamepad-stick.js');
const { createVoiceControl, VOICE_KEYS, migrateKeyWordSettings47, migrateSchemeSwitches48 } = require('./voice-control.js');
// v50: the cursor clutch state machine lives in its own module (see the
// file header for the "invisible wall at the top/bottom edge" fix).
const { createCursorClutch } = require('./cursor-clutch.js');
const { createVoiceClutch } = require('./voice-clutch.js');
const { createVoiceKeyHold } = require('./voice-key-hold.js');

// --- Voice control (added feature, v34) ---------------------------------------
// Offline keyword spotting ("开启"/"关闭" etc.). The renderer owns the
// microphone and streams PCM chunks here via 'voiceAudio'; a recognized word
// becomes an explicit on/off command (same code path as the mode hotkey on
// the renderer side for cursor movement, but idempotent rather than
// toggling). v36: besides the scheme pair, the spotter also listens for the
// enabled per-feature switch pairs ("移动/静止" cursor movement, "眨眼/闭眼"
// blink click, "张嘴/闭嘴" mouth click); commands carry a `command` field so
// the renderer knows which switch to flip.
const voiceControl = createVoiceControl({
	getModelDir: () => path.join(app.getAppPath(), 'node_modules/tracky-mouse/vendor/kws'),
	log: (line) => console.log(`[voice-control] ${line}`),
	onCommand: (payload) => {
		appWindow?.webContents.send('voiceCommand', payload);
		// v38: spoken commands drive the clutches too. Saying "张嘴" engages
		// the second clutch (so mouth clicking actually works without anyone
		// pressing its key), "眨眼" the third clutch, and the movement words
		// ("开启"/"移动" etc.) the main clutch. A later press of the physical
		// clutch key always hands control back to the hardware (see the
		// watcher listeners below).
		voiceClutch.apply(payload.command, payload.action, activeSettings);
		if (payload.command === 'voiceKey') {
			// v43/v47: a spoken voice key word (左键/右键/中键 by default)
			// (re)arms its slot's hold window - the keys stay pressed while
			// the word is being said; the expiry timer below releases them.
			voiceKeyHold.press(payload.source, Date.now());
			syncVoiceKeyStates();
		}
		// v38: cursor-side feedback for EVERY recognized word - the app window
		// may be minimized, so its toast isn't always visible; the yellow "!"
		// on the overlay (see updateDwellClickingAndHUD) always is.
		// v44: voice keys ARE the button and fire every time they are spoken,
		// so their "!" is hidden unless the user explicitly unticked the hide
		// option (undefined = the row's default "hidden", matching the UI).
		if (payload.command !== 'voiceKey' || activeSettings.voiceKeyHideIndicator === false) {
			voiceIndicatorUntil = Date.now() + VOICE_INDICATOR_MS;
		}
		syncGestureStates();
	},
});

// v38: voice command → clutch overrides ("张嘴" engages the second clutch,
// etc.; see voice-clutch.js).
const voiceClutch = createVoiceClutch({ log: (line) => console.log(`[voice-clutch] ${line}`) });

// v43: voice key hold windows ("左"/"右"/"中" hold user-bound keys down
// while the word keeps being said; see voice-key-hold.js). The expiry
// timer runs 10×/s: while a slot is armed and the mic still carries voice
// energy (a sustained "一——" — the spotter usually fires only once per
// phrase), the hold window keeps extending; otherwise windows simply age
// out. unref'd: in the real app other handles keep the event loop alive,
// and the harnesses can exit without a dangling timer.
const voiceKeyHold = createVoiceKeyHold({ log: (line) => console.log(`[voice-key-hold] ${line}`) });
setInterval(() => {
	const now = Date.now();
	if (voiceControl.isSpeechActive()) {
		for (const id of Object.keys(VOICE_KEYS)) {
			voiceKeyHold.extend(id, now);
		}
	}
	const released = voiceKeyHold.tick(now);
	if (released.length > 0) {
		syncVoiceKeyStates();
		// v44: once no slot is held any more the mouth click gate must be
		// re-evaluated (the hold-period suppression lifts).
		syncGestureStates();
	}
}, 100).unref();
// v38: how long the yellow "!" stays next to the cursor after a recognized word.
const VOICE_INDICATOR_MS = 1000;
let voiceIndicatorUntil = 0;

let screenScaleFactor = 1;
function updateScreenScaleFactor() {
	// Must wait for ready event before calling this
	screenScaleFactor = screen.getPrimaryDisplay().scaleFactor;
}

/**
 * Computes the bounding rectangle that spans all connected displays.
 * Must be called after the app 'ready' event.
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
function computeVirtualDisplayBounds() {
	const displays = screen.getAllDisplays();
	const x = Math.min(...displays.map(d => d.bounds.x));
	const y = Math.min(...displays.map(d => d.bounds.y));
	const right = Math.max(...displays.map(d => d.bounds.x + d.bounds.width));
	const bottom = Math.max(...displays.map(d => d.bounds.y + d.bounds.height));
	return { x, y, width: right - x, height: bottom - y };
}

/**
 * Center of the display the cursor is currently on, in the same
 * virtual-desktop CSS px space the head tracker works in.
 *
 * Recenter on enable (added feature, v29): this is where tracking starts from,
 * so "head still = cursor exactly at the center" holds. Using the center of
 * the whole virtual desktop instead would land somewhere else entirely as soon
 * as there's more than one monitor (a spot near the bottom-left of the main
 * screen, for a second monitor placed to the left / below it).
 *
 * @param {{x: number, y: number}} curPos cursor position (CSS px, virtual desktop)
 * @returns {{x: number, y: number}}
 */
function computeRecenterPoint(curPos) {
	let display = null;
	try {
		display = screen.getDisplayNearestPoint?.({ x: Math.round(curPos.x), y: Math.round(curPos.y) });
	} catch {
		display = null;
	}
	display = display || screen.getPrimaryDisplay();
	const bounds = display.bounds;
	return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

/**
 * Where the cursor goes when tracking is switched on (v30):
 * "center" = the center of the display it is on, "hold" = leave it untouched.
 * Falls back to the v29 checkbox value when the new setting isn't saved yet.
 */
function getRecenterMode() {
	if (activeSettings.recenterMode === 'hold' || activeSettings.recenterMode === 'center') {
		return activeSettings.recenterMode;
	}
	return activeSettings.recenterOnEnable === false ? 'hold' : 'center';
}

// --- Mode hotkeys (added feature, v30) ---------------------------------------
// Mouse mode and game mode are switched with global hotkeys, because they have
// to work while a game (or anything else) has focus. The settings store a key
// spec in the same format as the clutch keys ("vk:0x78"), so the existing key
// recorder can be reused; Electron's globalShortcut wants an accelerator name
// ("F9") instead, hence this small translation table.
const VK_TO_ACCELERATOR = (() => {
	const map = new Map();
	for (let i = 0; i < 24; i++) {
		map.set(0x70 + i, `F${i + 1}`);
	}
	for (let i = 0; i < 10; i++) {
		map.set(0x30 + i, `${i}`);
	}
	for (let i = 0; i < 26; i++) {
		map.set(0x41 + i, String.fromCharCode(0x41 + i));
	}
	const named = {
		0x08: 'Backspace', 0x09: 'Tab', 0x0D: 'Return', 0x13: 'Pause', 0x14: 'Capslock',
		0x1B: 'Escape', 0x20: 'Space', 0x21: 'PageUp', 0x22: 'PageDown', 0x23: 'End',
		0x24: 'Home', 0x25: 'Left', 0x26: 'Up', 0x27: 'Right', 0x28: 'Down',
		0x2C: 'PrintScreen', 0x2D: 'Insert', 0x2E: 'Delete',
	};
	for (const [vk, name] of Object.entries(named)) {
		map.set(Number(vk), name);
	}
	return map;
})();

/** Parses "vk:0x78" / "vk:120" into a virtual-key number, or null. */
function parseVkSpec(spec) {
	if (typeof spec !== 'string') {
		return null;
	}
	const match = spec.trim().match(/^(?:vk|key):(0x[0-9a-fA-F]+|[0-9]+)$/);
	if (!match) {
		return null;
	}
	const raw = match[1];
	const vk = /^0x/i.test(raw) ? parseInt(raw, 16) : parseInt(raw, 10);
	return Number.isFinite(vk) ? vk : null;
}

/** "vk:0x78" → "F9"; null when the key can't be a global hotkey. */
function vkSpecToAccelerator(spec) {
	const vk = parseVkSpec(spec);
	if (vk === null) {
		return null;
	}
	return VK_TO_ACCELERATOR.get(vk) ?? null;
}

let registeredModeAccelerators = [];

function unregisterModeShortcuts() {
	for (const accelerator of registeredModeAccelerators) {
		try {
			globalShortcut.unregister(accelerator);
		} catch {
			// ignore
		}
	}
	registeredModeAccelerators = [];
}

function registerModeShortcuts() {
	unregisterModeShortcuts();
	const entries = [
		['mouse', activeSettings.mouseModeToggleKey || MOUSE_MODE_DEFAULT_KEY],
		['game', activeSettings.gameModeToggleKey || GAME_MODE_DEFAULT_KEY],
	];
	const taken = new Set();
	for (const [mode, spec] of entries) {
		const accelerator = vkSpecToAccelerator(spec);
		if (!accelerator) {
			console.warn(`[mode-hotkey] "${spec}" cannot be used as a global hotkey (only keyboard keys are supported).`);
			continue;
		}
		if (taken.has(accelerator)) {
			console.warn(`[mode-hotkey] ${accelerator} is assigned to both modes; keeping it for the first one only.`);
			continue;
		}
		taken.add(accelerator);
		try {
			const ok = globalShortcut.register(accelerator, () => {
				if (mode === 'game') {
					setGameModeActive(!gameModeActive);
				} else {
					// Mouse mode = ordinary tracking on/off: the renderer owns
					// that state (it pauses the camera and the pointer).
					appWindow?.webContents.send("shortcut", "toggle-tracking");
				}
			});
			if (ok) {
				registeredModeAccelerators.push(accelerator);
			} else {
				console.error(`[mode-hotkey] failed to register ${accelerator} for ${mode} mode - another program probably owns it.`);
			}
		} catch (error) {
			console.error(`[mode-hotkey] failed to register ${accelerator}:`, error);
		}
	}
}

/** Snapshot of both mode switches, mirrored to the settings tab bar. */
function modeStatePayload() {
	return {
		mouse: enabled,
		game: gameModeActive,
		mouseKey: activeSettings.mouseModeToggleKey || MOUSE_MODE_DEFAULT_KEY,
		gameKey: activeSettings.gameModeToggleKey || GAME_MODE_DEFAULT_KEY,
	};
}

function notifyModeState() {
	appWindow?.webContents.send('modeState', modeStatePayload());
}

/**
 * Pushes the current game-mode state to the helper. Turning game mode off
 * releases everything the virtual pad could be holding: both sticks, every
 * stick-direction key, the Joy-Con bridge, and all Joy-To-Key mappings.
 */
function applyGameMode() {
	if (!gameModeActive) {
		sendGamepadSticks(0, 0, 0, 0);
		// v31: release every plate key explicitly (an empty report does that)
		// before the table is dropped - the head-touch pad belongs to game mode.
		syncTouchZoneStates([]);
	}
	// Stick → key mappings (desktop stick directions): closing the gate makes
	// the helper release every key those mappings hold.
	pushStickGate();
	// Joy-Con bridge (the helper is told to disengage), and the mapping table
	// (emptied while game mode is off, which also releases Joy-To-Key keys).
	syncJoyconBridge();
	// Push what the NEW mode should have BEFORE any restart, so a helper that
	// is about to go away (or be re-spawned) releases its keys first and the
	// fresh one starts from the right table instead of replaying stale state.
	sendGamepadConfig(buildKeymapConfig());
	syncTouchZonesConfig();
	// v31: start / stop the helper, and switch it between pad and padless mode.
	// Leaving game mode restarts it without the virtual pad, so the controller
	// disappears right away instead of at quit (which used to stall the system
	// while Windows re-scanned the device list).
	if (gamepadStickWanted()) {
		const spawned = startGamepadStick({ app, withPad: gamepadPadWanted() });
		if (spawned) {
			// A fresh helper holds no keys: drop the mirrors so what is still
			// wanted gets pressed again.
			lastGestureDown = { blink: false, mouth: false };
			lastTouchZoneDown = new Set();
		}
		// Idempotent: the de-duplicating senders skip what the spawn already
		// replayed, and the others cover first-run / config loads.
		sendGamepadConfig(buildKeymapConfig());
		sendPulseConfig(activeSettings.headStickPulse !== false);
		sendGripConfig(activeSettings.joyconGripMode);
		pushStickGate();
		// Head touch pad: game mode only (v31). The table is cleared while it
		// is off, which also releases any plate key the helper still holds.
		syncTouchZonesConfig();
		syncGestureStates();
	} else if (isGamepadStickRunning()) {
		stopGamepadStick();
	}
	notifyModeState();
	logHelperEvent(`game mode ${gameModeActive ? 'ON' : 'OFF'}`);
}

function setGameModeActive(active) {
	const next = active !== false;
	if (next === gameModeActive) {
		notifyModeState();
		return;
	}
	gameModeActive = next;
	applyGameMode();
}

const { updateMenu, getCustomMenuBarModel, invokeMenuItemById } = require("./menus.js");const { installCrashRecovery } = require('./crash-recovery.js');

// Allow recovering from WebGL crash unlimited times.
// (To test the recovery, I've been using Ctrl+Alt+F1 and Ctrl+Alt+F2 in Ubuntu.
// Note, if Ctrl + Alt + F2 doesn't get you back, try Ctrl+Alt+F7.)
app.commandLine.appendSwitch("disable-gpu-process-crash-limit");
// Allow auto-scrolling with middle click on platforms other than Windows.
// This makes it easier to navigate the settings when using Tracky Mouse's
// "Open mouth to click (with eye gestures)" mode, since Tracky Mouse doesn't currently
// provide a way to trigger mouse wheel events, but it does let you middle click.
app.commandLine.appendSwitch("enable-blink-features", "MiddleClickAutoscroll");


let activeSettings = {};

let enabled = true;

// --- Two scenes (added feature, v30) -----------------------------------------
// The app is used in two situations that need different parts of it:
//  - MOUSE MODE: cursor movement, clicking, gestures, head-touch keys.
//  - GAME MODE:  virtual gamepad sticks, stick → key mappings, Joy-Con
//                bridging and Joy-To-Key.
// "Mouse mode" is exactly the existing tracking switch (`enabled`, F9). Game
// mode is an independent flag gating every virtual-gamepad output, with its
// own global hotkey. Both hotkeys are user-configurable.
const MOUSE_MODE_DEFAULT_KEY = 'vk:0x78'; // F9
const GAME_MODE_DEFAULT_KEY = 'vk:0x79'; // F10
// v31: game mode starts OFF, every launch. Creating the virtual pad at startup
// made Windows pop up a "new controller" notice each time, and destroying it on
// quit made the system stall while re-scanning devices. With game mode off the
// helper runs without a pad (only key injection for the mouse-mode gestures),
// so nothing is added or removed from the device list.
let gameModeActive = false;


// --- Clutch mode (added feature) ---------------------------------------------
// Gate cursor movement on a configurable "clutch key" (a mouse button,
// keyboard key, or gamepad button, see settings "clutchKey"):
// - "hold" mode: the cursor only moves while the clutch key is held down.
// - "toggle" mode: each press of the clutch key switches movement on/off.
// While movement is disengaged, the head tracker's virtual pointer is pinned
// back onto the real cursor, so that re-engaging continues from where the
// cursor actually is instead of jumping.
//
// --- Second clutch (added feature) --------------------------------------------
// An independent clutch (settings "secondClutch"): facial clicking is DISABLED
// by default, and only works while the second clutch is engaged - the cursor
// keeps following the head normally either way. Use it to keep mouth-open
// clicking off until you deliberately call for it (e.g. while playing a game),
// then press the second clutch key to enable clicking.
// See settings "secondClutchKey" / "secondClutchMode".
//
// --- Head → virtual gamepad sticks (added feature) ----------------------------
// Head position can drive the virtual Xbox 360 pad's LEFT stick (movement) and
// RIGHT stick (camera). Each stick has its own clutch key and hold/toggle mode
// (setting "headStickRight" + ...Key/...Mode), so it is independent of the
// other virtual-pad features.
// "headStickRightInvert" flips the right stick horizontally and
// "headStickRightInvertY" flips it vertically; "headStickDeadzone" ignores
// tiny head movements around the center.
// v50: `clutchBlocked` moved into cursorClutch (cursor-clutch.js).
let clutchToggleActive = false; // toggle mode: whether movement is currently allowed
let secondToggleActive = false; // second clutch toggle mode: whether clicking is currently enabled
let thirdToggleActive = false; // third clutch toggle mode (v28): whether blink clicking is currently enabled
let rightStickToggleActive = false; // right stick clutch toggle mode: whether it's driving the stick
let touchZonesToggleActive = false; // touch zones clutch toggle mode: whether the touch keys may fire
let touchZones2ToggleActive = false; // touch zones scheme-2 clutch toggle mode (v22)
let touchZonesExToggleActive = false; // touch zones exclusive switch toggle mode (v25): scheme 2 currently active
let bridgeToggleActive = false; // Joy-Con bridge clutch toggle mode: whether bridging is engaged
let stickDesktopToggleActive = false; // desktop stick mapping clutch toggle mode (v27): whether stick→key mappings may fire
// v50: moved into createCursorClutch() (cursor-clutch.js). The old frozen
// anchor survived real-cursor movement during the parked period (the enable
// teleport, physical mouse moves) inside clutchOffset, shifting the whole
// reachable cursor range - "can't reach the top/bottom edge, center not in
// the middle". The module re-anchors against the current cursor every
// blocked frame instead.
let lastClutchPinTime = 0;
const cursorClutch = createCursorClutch({
	isEnabled: () => activeSettings.requireLeftButtonToMove !== false,
	isEngaged: () => isClutchEngaged(),
	onPin: (curPos) => pinRendererPointerToCursor(curPos),
});

function getClutchMode() {
	return activeSettings.clutchMode === 'toggle' ? 'toggle' : 'hold';
}

function isClutchEngaged() {
	// v38: a spoken movement command ("开启"/"移动" etc.) engages the clutch
	// without any key; the physical key takes over again on its next edge.
	if (getClutchMode() === 'toggle') {
		return voiceClutch.gate('main', clutchToggleActive);
	}
	return voiceClutch.gate('main', isClutchKeyHeld());
}

function getSecondClutchMode() {
	return activeSettings.secondClutchMode === 'toggle' ? 'toggle' : 'hold';
}

/**
 * Second clutch (added feature, v24): true while facial clicking is allowed.
 * Note the inverted semantics vs. the old "freeze" behavior: clicking is off
 * by default and the second clutch key *enables* it. In "hold" mode clicking
 * works while the second clutch key is held down; in "toggle" mode each press
 * flips it, and clicking starts disabled on every app launch. With the second
 * clutch disabled in settings, clicking is always allowed (pre-patch
 * behavior). Fail closed: until the watcher reports a state, clicking stays
 * off, matching the "disabled by default" intent.
 */
function isSecondClutchEngaged() {
	let base;
	if (activeSettings.secondClutch === false) {
		base = true;
	} else if (getSecondClutchMode() === 'toggle') {
		base = secondToggleActive;
	} else {
		base = secondClutchWatcher.isReady() && secondClutchWatcher.isHeld();
	}
	// v38: saying "张嘴" engages this clutch; the key takes over on its next edge.
	return voiceClutch.gate('second', base);
}

function getThirdClutchMode() {
	return activeSettings.thirdClutchMode === 'toggle' ? 'toggle' : 'hold';
}

/**
 * Third clutch (added feature, v28): true while BLINK clicking is allowed.
 * Mirrors the second clutch exactly, but gates the blink click: blink
 * clicking is off by default and the third clutch key *enables* it. In
 * "hold" mode it works while the key is held down; in "toggle" mode each
 * press flips it, starting disabled on every app launch. With the checkbox
 * disabled in settings, blink clicking is always allowed while the "Blink
 * click" feature is on. Fail closed: until the watcher reports a state,
 * blink clicking stays off.
 */
function isThirdClutchEngaged() {
	let base;
	if (activeSettings.thirdClutch !== true) {
		base = true;
	} else if (getThirdClutchMode() === 'toggle') {
		base = thirdToggleActive;
	} else {
		base = thirdClutchWatcher.isReady() && thirdClutchWatcher.isHeld();
	}
	// v38: saying "眨眼" engages this clutch; the key takes over on its next edge.
	return voiceClutch.gate('third', base);
}

// --- Gesture → key bindings (added feature, v28) ------------------------------
// Blink click and mouth click can each be bound to a key sequence (like the
// touch-zone plates and the Joy-To-Key targets). The renderer reports the raw
// gesture state per frame ('setGestureStates'); this side gates it - blink on
// the third clutch, mouth on the second clutch, both on the global tracking
// switch - and forwards press/release edges to the helper as pseudo touch
// zones "H:blink" / "H:mouth", so injection reuses the exact zone machinery
// (hold semantics, multi-key sequences, wheel, mouse buttons).
// An unbound gesture falls back to the LEFT mouse button, mirroring the
// pre-patch facial clicking behavior.
let lastReportedGestures = { blink: false, mouth: false };
let lastGestureDown = { blink: false, mouth: false };

/** Zone-table entries for the enabled gesture clicks (empty = left click). */
function configuredGestureZones() {
	const entries = [];
	if (activeSettings.blinkClick === true) {
		entries.push({ id: 'H:blink', key: activeSettings.blinkClickKeys || 'mouse:left' });
	}
	if (activeSettings.mouthClick === true) {
		entries.push({ id: 'H:mouth', key: activeSettings.mouthClickKeys || 'mouse:left' });
	}
	return entries;
}

// Voice keys (added feature, v43): the spoken keys ("左"/"右"/"中") ride the
// same zone machinery as pseudo zones "H:v1".."H:v3". An empty binding falls
// back to the LEFT mouse button, mirroring the gesture clicks above.
function configuredVoiceKeyZones() {
	const entries = [];
	for (const id of Object.keys(VOICE_KEYS)) {
		const n = id.slice(1);
		if (activeSettings[`voiceKey${n}Enabled`] === true) {
			entries.push({ id: `H:${id}`, key: activeSettings[`voiceKey${n}Keys`] || 'mouse:left' });
		}
	}
	return entries;
}

/** Press/release mirror for the voice-key pseudo zones. */
const lastVoiceKeyDown = new Set();

/** Applies the voice-key hold state to the helper (press/release on edges). */
function syncVoiceKeyStates() {
	for (const id of Object.keys(VOICE_KEYS)) {
		const down = voiceKeyHold.isDown(id);
		if (down && !lastVoiceKeyDown.has(id)) {
			lastVoiceKeyDown.add(id);
			sendGamepadZoneState(`H:${id}`, true);
		} else if (!down && lastVoiceKeyDown.has(id)) {
			lastVoiceKeyDown.delete(id);
			sendGamepadZoneState(`H:${id}`, false);
		}
	}
}

/** Whether ANY voice-key slot is currently held down (v44). Speaking a voice
 * key moves the jaw, so the mouth gesture fires on top of it - while a slot
 * is held, the mouth CLICK channel is suppressed so the two stay independent
 * (runtime only: never persisted, gone when the key releases). */
function anyVoiceKeyHeld() {
	return Object.keys(VOICE_KEYS).some((id) => voiceKeyHold.isDown(id));
}

/** Applies the gates to the latest renderer report and syncs the helper. */
function syncGestureStates() {
	const wants = {
		blink: activeSettings.blinkClick === true
			&& lastReportedGestures.blink
			&& enabled
			&& isThirdClutchEngaged(),
		// v44: the voice-key hold suppresses the mouth click so saying
		// "左"/"右"/"中" (which moves the jaw) cannot fire the mouth click on
		// top of the voice key - each channel stays independent no matter
		// which combination of switches is on.
		mouth: activeSettings.mouthClick === true
			&& lastReportedGestures.mouth
			&& enabled
			&& isSecondClutchEngaged()
			&& !anyVoiceKeyHeld(),
	};
	for (const name of ['blink', 'mouth']) {
		if (wants[name] !== lastGestureDown[name]) {
			lastGestureDown[name] = wants[name];
			sendGamepadZoneState(`H:${name}`, wants[name]);
		}
	}
}

function pinRendererPointerToCursor(curPos) {
	const now = performance.now();
	if (now - lastClutchPinTime < 15) { // ~60Hz is plenty
		return;
	}
	lastClutchPinTime = now;
	appWindow?.webContents.send('clutchPinPointer', Math.round(curPos.x), Math.round(curPos.y));
}

function resetClutch() {
	clutchToggleActive = false;
	secondToggleActive = false;
	thirdToggleActive = false;
	touchZonesExToggleActive = false;
	stickDesktopToggleActive = false;
	// v50: the blocked/anchor/offset trio lives in cursorClutch now.
	cursorClutch.reset();
	// v38: a re-configured clutch shouldn't inherit a spoken override.
	voiceClutch.reset();
}

// In toggle mode, each press of the clutch key flips movement on/off.
// In hold mode the key state is polled directly on every mouse move instead.
onClutchKeyStateChange((down) => {
	// v38: touching the physical clutch key hands control back from voice to
	// hardware (any edge clears the spoken override).
	voiceClutch.onPhysicalKey('main');
	if (getClutchMode() !== 'toggle' || activeSettings.requireLeftButtonToMove === false) {
		return;
	}
	if (down) {
		clutchToggleActive = !clutchToggleActive;
		// v50: no anchor clearing needed here any more - every disengaged
		// frame re-anchors onto the real cursor position (cursor-clutch.js).
	}
});

// Second clutch (added feature, v24): in toggle mode, each press of the
// second clutch key enables/disables facial clicking (starting disabled).
secondClutchWatcher.onStateChange((down) => {
	voiceClutch.onPhysicalKey('second'); // v38: physical key beats voice
	if (getSecondClutchMode() === 'toggle' && activeSettings.secondClutch !== false && down) {
		secondToggleActive = !secondToggleActive;
	}
	// v28: the second clutch also gates the mouth click key binding, so
	// every key edge re-syncs (a hold-mode release must release the bound
	// keys, not just toggle-mode presses flipping the state).
	syncGestureStates();
});

// Third clutch (added feature, v28): in toggle mode, each press of the third
// clutch key enables/disables blink clicking (starting disabled). In hold
// mode, re-syncing here releases (or re-presses) the bound keys as soon as
// the clutch key changes.
thirdClutchWatcher.onStateChange((down) => {
	voiceClutch.onPhysicalKey('third'); // v38: physical key beats voice
	if (activeSettings.thirdClutch !== true) {
		return;
	}
	if (getThirdClutchMode() === 'toggle' && down) {
		thirdToggleActive = !thirdToggleActive;
	}
	syncGestureStates();
});

/**
 * Whether one of the stick clutches is currently letting the head drive its
 * stick. "Always" needs no key (this is how the virtual sticks worked before
 * they had clutches); hold mode polls the key state; toggle mode uses the
 * flipper above. Fail closed: until the helper has reported a key state, the
 * stick doesn't move (an unintended stick input in a game is worse than a
 * missing one).
 */
function isStickClutchEngaged(watcher, enabled, mode, toggleActive) {
	if (enabled !== true) {
		return false;
	}
	if (mode === 'always') {
		return true;
	}
	if (mode === 'toggle') {
		return toggleActive;
	}
	return watcher.isReady() && watcher.isHeld();
}

/** Whether a stick clutch mode needs a key watcher process at all. */
function stickClutchNeedsWatcher(mode) {
	return mode !== 'always';
}

// Touch zones clutch (added feature): hold mode engages while the key is held;
// in toggle mode each press flips whether the touch keys may fire. Either way,
// re-sync the live zone keys from the last renderer report so a mid-game
// engage/disengage presses or releases them immediately.
touchZonesClutchWatcher.onStateChange((down) => {
	if (!down) {
		syncTouchZoneStates(lastReportedTouchIds);
		return;
	}
	if (activeSettings.touchZonesEnabled !== true) {
		return;
	}
	if (touchZoneMode(1) === 'toggle') {
		touchZonesToggleActive = !touchZonesToggleActive;
	}
	syncTouchZoneStates(lastReportedTouchIds);
});
// Touch zones scheme-2 clutch (v22): same contract as scheme 1, but flips the
// scheme-2 toggle and re-gates only scheme-2 plates.
touchZones2ClutchWatcher.onStateChange((down) => {
	if (!down) {
		syncTouchZoneStates(lastReportedTouchIds);
		return;
	}
	if (activeSettings.touchZonesEnabled !== true) {
		return;
	}
	if (touchZoneMode(2) === 'toggle') {
		touchZones2ToggleActive = !touchZones2ToggleActive;
	}
	syncTouchZoneStates(lastReportedTouchIds);
});
// Touch zones exclusive switch (v25): engaging or disengaging it swaps which
// scheme is live, so re-gate the plates on every state change. In toggle mode
// each press flips which scheme is active (starting on scheme 1).
touchZonesExClutchWatcher.onStateChange((down) => {
	if (activeSettings.touchZonesExclusive !== true || activeSettings.touchZonesEnabled !== true) {
		return;
	}
	if (touchZonesExclusiveMode() === 'toggle') {
		if (!down) {
			return;
		}
		touchZonesExToggleActive = !touchZonesExToggleActive;
	}
	syncTouchZoneStates(lastReportedTouchIds);
});
rightStickClutchWatcher.onStateChange((down) => {
	if (!down || activeSettings.headStickRight !== true || activeSettings.headStickRightMode !== 'toggle') {
		return;
	}
	rightStickToggleActive = !rightStickToggleActive;
});

// --- Joy-Con → virtual gamepad bridge (added feature) -------------------------
// While the bridge is engaged, real Joy-Con / Pro Controller input takes over
// the virtual pad whenever the controllers are actively used (pressed buttons,
// triggers, or a stick beyond a dead zone); while the controllers are idle,
// head tracking keeps driving the sticks, so an "always on" bridge never
// blocks the head → stick features. See tracky-vigem-stick's header comment.
let lastBridgeWanted = false;

function getRawBridgeMode(rawMode) {
	return rawMode === 'toggle' ? 'toggle' : (rawMode === 'always' ? 'always' : 'hold');
}

function getBridgeClutchMode() {
	return getRawBridgeMode(activeSettings.joyconBridgeClutchMode);
}

/** Whether Joy-Con bridging should currently be engaged. */
function isJoyconBridgeWanted() {
	if (activeSettings.joyconBridge !== true) {
		return false;
	}
	// v30: game mode off = Joy-Con input is not forwarded (the controller is
	// left to the games / the system, exactly as if the bridge were off).
	if (!gameModeActive) {
		return false;
	}
	const mode = getBridgeClutchMode();
	if (mode === 'always') {
		return true;
	}
	// A hold/toggle clutch with NO key assigned can never engage (the watcher
	// isn't even started, and toggle would start "off"), which made the bridge
	// look dead for users who never touched the clutch settings. Treat that
	// degenerate config as "always" instead - it's what they asked for by
	// turning the bridge on.
	if (!(activeSettings.joyconBridgeClutchKey || '')) {
		return true;
	}
	if (mode === 'toggle') {
		return bridgeToggleActive;
	}
	// Hold mode. Fail closed like the stick clutches: until the helper has
	// reported a key state, don't engage.
	return joyconBridgeClutchWatcher.isReady() && joyconBridgeClutchWatcher.isHeld();
}

/** Pushes the current engaged state to the helper (only when it changed). */
function syncJoyconBridge() {
	const wanted = isJoyconBridgeWanted();
	if (wanted === lastBridgeWanted) {
		return;
	}
	lastBridgeWanted = wanted;
	sendBridgeEnabled(wanted);
	// Make the engagement visible in the helper log - "the bridge does nothing"
	// is a lot easier to debug when the log shows whether the app ever told the
	// helper to engage (the helper logs its own "Joy-Con -> pad bridge enabled=").
	logHelperEvent(`bridge ${wanted ? 'ENGAGED' : 'disengaged'} (Joy-Con input may take over the pad)`);
}

// The bridge is push-based (the helper is told when to engage), so every key
// state change must be pushed - not just toggle flips: in hold mode this is
// the only signal that the key was pressed or released, and the first report
// also flips the watcher from "not ready" (fail closed) to a known state.
joyconBridgeClutchWatcher.onStateChange((down) => {
	if (activeSettings.joyconBridge === true && down && getBridgeClutchMode() === 'toggle') {
		bridgeToggleActive = !bridgeToggleActive;
	}
	syncJoyconBridge();
});

/** Converts a -1..1 axis value to a raw stick value. */
function stickAxisToRaw(value) {
	return Math.round(Math.max(-1, Math.min(1, value)) * 32767);
}

/**
 * Maps a head-tracking target position onto normalized stick axes.
 * -1..1 in screen convention (+y = down), with a radial dead zone so small
 * involuntary head movements don't nudge the sticks.
 * @param {number} x head target x (CSS px in the virtual desktop)
 * @param {number} y head target y
 * @param {{x: number, y: number, width: number, height: number}} bounds virtual display bounds
 * @returns {{x: number, y: number}}
 */
function computeStickAxes(x, y, bounds) {
	const centerX = bounds.x + bounds.width / 2;
	const centerY = bounds.y + bounds.height / 2;
	let nx = (x - centerX) / (bounds.width / 2);
	let ny = (y - centerY) / (bounds.height / 2);
	nx = Math.max(-1, Math.min(1, nx));
	ny = Math.max(-1, Math.min(1, ny));
	const deadzone = Math.max(0, Math.min(0.9, Number(activeSettings.headStickDeadzone) || 0));
	const magnitude = Math.hypot(nx, ny);
	if (magnitude <= deadzone) {
		return { x: 0, y: 0 };
	}
	// Rescale so full deflection is still reached at the edge of the screen.
	const scale = Math.min(1, (magnitude - deadzone) / (1 - deadzone)) / magnitude;
	return { x: nx * scale, y: ny * scale };
}

/**
 * Feeds the current head position into the virtual gamepad's sticks. Called
 * every frame; each stick only moves while its own clutch is engaged, and both
 * are centered otherwise. Independent of the cursor clutch.
 */
function updateGamepadSticks(x, y, paused, bounds) {
	if (!isGamepadStickRunning()) {
		return;
	}
	// v19: the head → LEFT stick feature was replaced by the head-touch zones
	// (see syncTouchZoneStates); only the right stick follows the head now.
	if (paused || activeSettings.headStickRight !== true) {
		// Tracking paused, or the stick feature off: keep the stick centered.
		sendGamepadSticks(0, 0, 0, 0);
		return;
	}
	const rightEngaged = isStickClutchEngaged(
		rightStickClutchWatcher, activeSettings.headStickRight,
		activeSettings.headStickRightMode, rightStickToggleActive,
	);
	if (!rightEngaged) {
		sendGamepadSticks(0, 0, 0, 0);
		return;
	}
	const axes = computeStickAxes(x, y, bounds);
	// "Invert right stick" flips the horizontal axis (head right = stick left);
	// "headStickRightInvertY" flips the vertical axis (head down = stick up).
	const rightX = activeSettings.headStickRightInvert === true ? -axes.x : axes.x;
	const rightY = activeSettings.headStickRightInvertY === true ? -axes.y : axes.y;
	sendGamepadSticks(
		0,
		0,
		stickAxisToRaw(rightX),
		stickAxisToRaw(rightY),
	);
}

// --- Head-touch zones (added feature) -----------------------------------------
// The renderer overlays "pressure plates" on the camera picture (like the pads
// of a dance machine) and reports each frame which zones the tracked nose is
// inside ('setTouchZoneStates'). Entering a plate presses (and holds) its key;
// leaving releases it. This side gates the reports on the global start/stop
// switch and the zones clutch, then forwards press/release edges to the helper
// executable, which owns the actual keyboard/mouse injection.
// v19: this replaces the head → LEFT stick projection.

let lastReportedTouchIds = []; // raw "id@layer" tags from the latest renderer report
let lastTouchZoneDown = new Set(); // "id@layer" tags whose key is currently injected
let lastTouchZonesConfigJson = null;

/**
 * Normalized clutch mode for a touch-zone scheme (added feature, v22: each
 * scheme has its own clutch; scheme 1 keeps the original setting keys).
 */
function touchZoneMode(layer) {
	const raw = layer === 2 ? activeSettings.touchZones2Mode : activeSettings.touchZonesMode;
	return raw === 'toggle' ? 'toggle' : (raw === 'always' ? 'always' : 'hold');
}

function touchZoneToggleActive(layer) {
	return layer === 2 ? touchZones2ToggleActive : touchZonesToggleActive;
}

function touchZonesClutchEngaged(layer = 1) {
	return isStickClutchEngaged(
		layer === 2 ? touchZones2ClutchWatcher : touchZonesClutchWatcher,
		activeSettings.touchZonesEnabled,
		touchZoneMode(layer),
		touchZoneToggleActive(layer),
	);
}

function touchZonesExclusiveMode() {
	return activeSettings.touchZonesExclusiveMode === 'toggle' ? 'toggle' : 'hold';
}

/**
 * Exclusive switch (added feature, v25): while active, scheme 1 is suspended
 * and scheme 2 takes over entirely, regardless of either scheme's own clutch
 * state. Hold mode polls the key; toggle mode flips on each press (scheme 1
 * active by default). Fail closed: until the watcher has reported a state,
 * the switch is considered inactive (scheme clutches rule as usual).
 */
function touchZonesExclusiveActive() {
	if (activeSettings.touchZonesExclusive !== true) {
		return false;
	}
	if (touchZonesExclusiveMode() === 'toggle') {
		return touchZonesExToggleActive;
	}
	return touchZonesExClutchWatcher.isReady() && touchZonesExClutchWatcher.isHeld();
}

// --- Desktop stick→key mapping (added feature, v27) ---------------------------
// Steam's "desktop layout" equivalent: stick directions can be bound to
// keyboard keys, mouse buttons, or wheel scrolling, and the mapping follows
// HOLD semantics - a sustained tilt holds the key down (OS auto-repeat keeps
// it firing, so a webpage keeps scrolling), re-centering releases it, and
// returning to center never fires a second press. Covers the head-controlled
// right stick ("H:stickRUp"…) and the Joy-Con / Pro sticks ("stickUp"…,
// "stickLUp"…, "stickRUp"…) alike. One clutch gates all of them:
// "always" (default, no key needed), "hold", or "toggle".

function getStickDesktopMode() {
	if (activeSettings.stickDesktopMode === 'toggle' || activeSettings.stickDesktopMode === 'hold') {
		return activeSettings.stickDesktopMode;
	}
	return 'always';
}

/**
 * Fail-open by design: with the feature enabled and mode "always" (the
 * default) no key is needed, so a missing watcher state must not block the
 * mappings. Hold mode needs the watcher to report a state first (fail
 * closed), toggle mode starts off.
 */
function isStickDesktopEngaged() {
	if (activeSettings.stickDesktop === false) {
		return false;
	}
	// v30: game mode off = no stick → key mappings at all.
	if (!gameModeActive) {
		return false;
	}
	const mode = getStickDesktopMode();
	if (mode === 'toggle') {
		return stickDesktopToggleActive;
	}
	if (mode === 'hold') {
		return stickDesktopClutchWatcher.isReady() && stickDesktopClutchWatcher.isHeld();
	}
	return true;
}

/** Pushes the desktop-mapping gate to the helper (no-op when it's not running). */
function pushStickGate() {
	sendStickGate(isStickDesktopEngaged());
}

stickDesktopClutchWatcher.onStateChange((down) => {
	if (activeSettings.stickDesktop === false) {
		return;
	}
	if (getStickDesktopMode() === 'toggle' && down) {
		stickDesktopToggleActive = !stickDesktopToggleActive;
	}
	pushStickGate();
});

/** "id@layer" tags (strings) from the current settings that have a key assigned. */
function configuredTouchZoneIds() {
	// v31: the head touch pad is a game-mode feature; while game mode is off
	// its plates must not fire at all (and the settings group is hidden too).
	if (!gameModeActive) {
		return [];
	}
	const zones = Array.isArray(activeSettings.touchZones) ? activeSettings.touchZones : [];
	return zones
		.filter((zone) => zone && zone.id !== undefined && zone.key)
		.map((zone) => `${String(zone.id)}@${zone.layer === 2 ? 2 : 1}`);
}

/** Pushes the zone → key table to the helper (only when it changed). */
function syncTouchZonesConfig() {
	const zones = Array.isArray(activeSettings.touchZones) ? activeSettings.touchZones : [];
	const entries = zones
		// v31: game mode off = no plates (the gesture pseudo zones below are
		// mouse-mode features and stay).
		.filter((zone) => gameModeActive && zone && zone.id !== undefined && zone.key)
		.map((zone) => ({ id: `${String(zone.id)}@${zone.layer === 2 ? 2 : 1}`, key: zone.key }))
		// Gesture → key bindings (v28): the blink/mouth clicks ride the same
		// zone machinery as pseudo zones "H:blink" / "H:mouth".
		.concat(configuredGestureZones())
		// Voice keys (v43): spoken words as pseudo zones "H:v1".."H:v3".
		.concat(configuredVoiceKeyZones());
	const json = JSON.stringify(entries);
	if (json === lastTouchZonesConfigJson) {
		return;
	}
	lastTouchZonesConfigJson = json;
	sendGamepadZones(entries);
	// Swapping the helper's table releases everything it holds; drop our
	// mirrors (both zone keys and the gesture click keys) so the next sync
	// re-presses whatever is still wanted.
	lastTouchZoneDown = new Set();
	lastGestureDown = { blink: false, mouth: false };
	voiceKeyHold.releaseAll();
	lastVoiceKeyDown.clear();
	syncGestureStates();
	syncVoiceKeyStates();
}

/**
 * Applies the (raw) renderer report against the current gates: presses and
 * releases zone keys on edges. Passing an empty array releases everything.
 * v22: each report entry is "id@layer" and is gated on its own scheme's
 * clutch (both on → an overlapping plate fires both keys at once).
 */
function syncTouchZoneStates(ids) {
	let wanted;
	if (activeSettings.touchZonesEnabled !== true) {
		wanted = [];
	} else {
		const configured = new Set(configuredTouchZoneIds());
		wanted = (Array.isArray(ids) ? ids : [])
			.map(String)
			.filter((tag) => {
				if (!configured.has(tag)) {
					return false;
				}
				const layer = tag.endsWith('@2') ? 2 : 1;
				// Exclusive switch (v25): while engaged, scheme 2 takes over and
				// scheme 1 is suspended, no matter the schemes' own clutches.
				if (touchZonesExclusiveActive()) {
					return layer === 2;
				}
				return touchZonesClutchEngaged(layer);
			});
	}
	const wantedSet = new Set(wanted);
	for (const id of wantedSet) {
		if (!lastTouchZoneDown.has(id)) {
			lastTouchZoneDown.add(id);
			sendGamepadZoneState(id, true);
		}
	}
	for (const id of [...lastTouchZoneDown]) {
		if (!wantedSet.has(id)) {
			lastTouchZoneDown.delete(id);
			sendGamepadZoneState(id, false);
		}
	}
}

/**
 * @param {number} x target x from the head tracker (CSS px in the virtual desktop)
 * @param {number} y target y from the head tracker
 * @param {{x: number, y: number}} curPos current real cursor position (same units)
 * @returns {{x: number, y: number, blocked: boolean}}
 */
function applyClutch(x, y, curPos) {
	// v50: the clutch logic moved to cursor-clutch.js, which re-anchors the
	// stitch offset against the current real cursor on every disengaged
	// frame. Keep this one piece of legacy state here: if the clutch was
	// switched off in settings while toggle mode still counted it as engaged,
	// drop that stale toggle state (the module clears its own).
	if (activeSettings.requireLeftButtonToMove === false && clutchToggleActive) {
		clutchToggleActive = false;
	}
	return cursorClutch.apply(x, y, curPos);
}

async function loadSettings() {
	let data;
	try {
		data = await fs.readFile(settingsFile, 'utf8');
	} catch (error) {
		if (error.code === 'ENOENT') {
			return;
		}
		throw error;
	}
	const settings = JSON.parse(data);
	if (settings.formatName !== formatName) {
		throw new Error("Settings file format name doesn't match");
	}
	// Upgrade settings here
	// e.g.:
	// if (settings.formatVersion === 0) {
	// 	settings.formatVersion++;
	// 	settings.newSettingName = settings.someOldSettingName;
	// 	delete settings.someOldSettingName;
	// }
	if (settings.formatVersion < formatVersion) {
		throw new Error(`Unsupported settings file format version. There is no upgrade path from ${settings.formatVersion} to ${formatVersion}.`);
	}
	if (settings.formatVersion > formatVersion) {
		throw new Error(`Unsupported settings file format version (${settings.formatVersion}). This version of the app only supports up to format version ${formatVersion}.`);
	}
	// Added feature (v14): the virtual gamepad's right stick used to be one of
	// the "game camera mode" values. It's now an independent stick projection
	// with its own clutch, so carry the old value over.
	// v15: that clutch defaults to "always" (no key), because the old camera
	// mode drove the stick all the time - a user who never asked for a clutch
	// shouldn't suddenly have to hold a button. An existing "hold"/"toggle"
	// setting that still has its stock default key is treated the same way.
	// v18: the Joy-Con → gamepad bridge is back, with an "always"-by-default
	// clutch of its own (real Joy-Con input takes over the pad whenever the
	// controllers are actively used).
	const globalSettings = settings.globalSettings;
	if (globalSettings) {
		if (globalSettings.gameCameraMode === 'rightStick') {
			globalSettings.gameCameraMode = 'off';
			if (globalSettings.headStickRight === undefined) {
				globalSettings.headStickRight = true;
			}
			globalSettings.headStickRightMode = 'always';
		}
		for (const [modeKey, keyKey, defaultKey] of [
			// v19: head → left stick became the head-touch zones (its own clutch),
			// so only the right stick keeps this migration.
			['headStickRightMode', 'headStickRightKey', RIGHT_STICK_DEFAULT_KEY_SPEC],
		]) {
			const mode = globalSettings[modeKey];
			const key = globalSettings[keyKey];
			if ((mode === 'hold' || mode === 'toggle') && (key === undefined || key === defaultKey)) {
				// Stock clutch settings nobody touched: let the stick follow the
				// head without a key, like the old camera mode did.
				globalSettings[modeKey] = 'always';
			}
		}
		// v20: v13's bridge was always available while its helper ran - the old
		// "bridge clutch" switch only gated it. A user upgrading from v13 (or
		// earlier) had Joy-Con → pad bridging WORKING without any "bridge"
		// checkbox (that checkbox only exists since v18, and v15-v17 had no
		// bridge at all), so restore it for them: when the settings file still
		// looks like a v13 install that used the virtual pad, switch the new
		// "Joy-Con → gamepad (bridge)" on. The one-shot marker keeps this from
		// fighting a user who deliberately turns the bridge off afterwards.
		if (globalSettings.joyconBridgeAutoEnabled !== true
			&& (globalSettings.joyconBridge === undefined || globalSettings.joyconBridge === false)) {
			const hadV13Bridge =
				// The v13 clutch switch still in the file: a pre-v18 settings
				// file, i.e. from a version where the bridge was always live.
				globalSettings.joyconBridgeClutch !== undefined
				// v13's helper (and with it the bridge) ran whenever Joy-To-Key
				// mappings existed, and the bridge came with it.
				|| (Array.isArray(globalSettings.joyconKeyMap) && globalSettings.joyconKeyMap.length > 0 && globalSettings.joyconKeyMapEnabled !== false);
			if (hadV13Bridge) {
				globalSettings.joyconBridge = true;
				globalSettings.joyconBridgeAutoEnabled = true;
				console.log("Migrated v13 Joy-Con bridge settings: joyconBridge = true");
			}
		}
		for (const obsoleteKey of [
			// v13's bridge clutch enable toggle; v18's bridge settings reuse the
			// "joyconBridgeClutchMode"/"joyconBridgeClutchKey" names, so only
			// this one key stays obsolete.
			'joyconBridgeClutch',
			// v19: head → left stick was replaced by the head-touch zones.
			'headStickLeft',
			'headStickLeftMode',
			'headStickLeftKey',
		]) {
			delete globalSettings[obsoleteKey];
		}
	}
	deserializeSettings(settings);
}

// TODO: DRY with loadSettings
// Could use a { sync: true, languageOnly: true } options object
// or could split out the shared functionality into a helper function
// like handleFormatUpgrade(settings)
function loadLanguageSettingSync() {
	// Handle --cli-lang <lang> and --cli-lang=<lang>
	const cliLangArg = process.argv.find(arg => arg === "--cli-lang" || arg.startsWith("--cli-lang="));
	if (cliLangArg) {
		let lang;
		if (cliLangArg === "--cli-lang") {
			const langIndex = process.argv.indexOf("--cli-lang");
			if (langIndex !== -1 && process.argv[langIndex + 1]) {
				lang = process.argv[langIndex + 1];
			}
		} else if (cliLangArg.startsWith("--cli-lang=")) {
			lang = cliLangArg.split("=")[1];
		}
		if (lang) {
			setLocale(lang);
			return;
		}
	}

	// Handle settings file
	let data;
	try {
		data = require('fs').readFileSync(settingsFile, 'utf8');
	} catch (error) {
		if (error.code === 'ENOENT') {
			return;
		}
		throw error;
	}
	const settings = JSON.parse(data);
	if (settings.formatName !== formatName) {
		throw new Error("Settings file format name doesn't match");
	}
	// Upgrade settings here
	// e.g.:
	// if (settings.formatVersion === 0) {
	// 	settings.formatVersion++;
	// 	settings.newSettingName = settings.someOldSettingName;
	// 	delete settings.someOldSettingName;
	// }
	if (settings.formatVersion < formatVersion) {
		throw new Error(`Unsupported settings file format version. There is no upgrade path from ${settings.formatVersion} to ${formatVersion}.`);
	}
	if (settings.formatVersion > formatVersion) {
		throw new Error(`Unsupported settings file format version (${settings.formatVersion}). This version of the app only supports up to format version ${formatVersion}.`);
	}
	// deserializeSettings(settings);
	if (settings.globalSettings.language !== undefined) {
		setLocale(settings.globalSettings.language);
	}
}
async function saveSettings() {
	await fs.writeFile(settingsFile, JSON.stringify(serializeSettings(), null, '\t'));
}
function serializeSettings() {
	// TODO: DRY with serializeSettings in tracky-mouse.js? The main stuff is taken care of now (listing every setting)
	// but it's still two places defining / dealing with the serialization format
	return {
		formatVersion,
		formatName,
		globalSettings: activeSettings,
		// profiles: [],
	};
};
function deserializeSettings(settings) {
	// TODO: DRY with deserializeSettings in tracky-mouse.js? The main stuff is taken care of now (listing every setting)
	// but it's still two places defining / dealing with the serialization format

	// Handles partial settings objects,
	// to allow manually editing the settings file, removing settings to reset them to their defaults,
	// as well as accepting settings updates over IPC from the UI.
	// Don't use `... in settings.globalSettings` to check if a setting is defined.
	// We must ignore `undefined` values so that the defaults carry over from the renderer to the main process in the Electron app.
	// Similarly, `Object.assign` would overwrite existing settings with undefined values.
	if ("globalSettings" in settings) {
		// v30 migration: the v29 checkbox "recenterOnEnable" became the
		// "recenterMode" choice ("center" / "hold"). Carry the old value over so
		// users who unchecked it keep the same behavior.
		if (settings.globalSettings
			&& settings.globalSettings.recenterMode === undefined
			&& settings.globalSettings.recenterOnEnable !== undefined) {
			settings.globalSettings.recenterMode = settings.globalSettings.recenterOnEnable === false ? 'hold' : 'center';
		}
		for (const key in settings.globalSettings) {
			if (settings.globalSettings[key] !== undefined) {
				activeSettings[key] = settings.globalSettings[key];
			}
		}
		if (settings.globalSettings.runAtLogin !== undefined) {
			if (app.isPackaged) {
				if (process.platform === 'win32') {
					// Handle Squirrel installer on Windows.
					// It places the app in a subdirectory, with a version number, but Update.exe can be used to launch the app.
					const appFolder = path.dirname(process.execPath);
					const updateExe = path.resolve(appFolder, '..', 'Update.exe');
					const exeName = path.basename(process.execPath);

					app.setLoginItemSettings({
						openAtLogin: activeSettings.runAtLogin,
						path: updateExe,
						args: [
							'--processStart', `"${exeName}"`,
							// '--process-start-args', '"--hidden"',
						]
					});
				} else {
					app.setLoginItemSettings({
						openAtLogin: activeSettings.runAtLogin,
					});
				}
			} else {
				// console.log("Ignoring runAtLogin setting because the app is not packaged.");
				// Could maybe try to pass it arguments to run the app in development mode, but it might not be worth it.
			}
		}
		if (settings.globalSettings.language !== undefined) {
			setLocale(settings.globalSettings.language);
			updateMenu();
		}
	}
}

let initialRelativeMouseMoveSent = false;
/**
 * On Windows, ensure the cursor is visible when using "Run at login".
 * 
 * This function is to ensure the cursor is made visible when you start controlling the computer with Tracky Mouse
 * when using "Run at login", since the cursor is otherwise invisible until you physically jostle the mouse.
 * Note: Calling the Win32 ShowCursor API does NOT make the cursor visible in this case.
 * I've tested this using AutoHotKey, logging out and in with the mouse unplugged.
 * Sending absolute mouse moves does NOT make the cursor visible.
 */
function ensureCursorVisibility() {
	if (process.platform !== 'win32') {
		return;
	}
	if (initialRelativeMouseMoveSent) {
		return;
	}
	ensureCursorVisibilityWithDriver();
	initialRelativeMouseMoveSent = true;
}

// setMouseLocation/getMouseLocation are asynchronous,
// which means we have to be smart about detecting manual mouse movement.
// We don't want to pause the mouse control due to head tracker based movement.
// So instead of detecting a distance from the last mouse position,
// we'll check against a history of positions.
// How long should the queue be? Points could be removed when setMouseLocation resolves,
// if and only if it's guaranteed that getMouseLocation will return the new position at that point.
// However, a simple time limit should be fine.
const mousePosHistoryDuration = 5000; // in milliseconds; affects time to switch back to camera control after manual mouse movement (although maybe it shouldn't)
const mousePosHistory = [];
async function setMouseLocationTracky(x, y) {
	ensureCursorVisibility();

	const time = performance.now();
	mousePosHistory.push({ point: { x, y }, time });
	// Test robustness using this artificial delay:
	// await new Promise((resolve) => setTimeout(resolve, Math.random() * 100));
	await setMouseLocationWithoutTracking(x * screenScaleFactor, y * screenScaleFactor);
}
function pruneMousePosHistory() {
	const now = performance.now();
	while (mousePosHistory[0] && now - mousePosHistory[0].time > mousePosHistoryDuration) {
		mousePosHistory.shift();
	}
}

// For testing
// let failSendingNextMessages = 0;

/** @type {BrowserWindow} */
let appWindow;
/** @type {BrowserWindow} */
let screenOverlayWindow;

const createWindow = () => {
	const appWindowState = windowStateKeeper({
		defaultWidth: 750,
		defaultHeight: 700,
	});

	// Create the browser window.
	appWindow = new BrowserWindow({
		x: appWindowState.x,
		y: appWindowState.y,
		width: appWindowState.width,
		height: appWindowState.height,
		backgroundColor: 'rgb(223, 204, 255)',
		webPreferences: {
			preload: path.join(app.getAppPath(), 'src/preload-app-window.js'),
			// Disable throttling of animations and timers so the mouse control can still work when minimized.
			backgroundThrottling: false,
		},
		icon: `${__dirname}/../../images/tracky-mouse-logo-512.png`,
		// Work around issue where clicking on titlebar buttons or right clicking on the titlebar
		// freezes the app on Windows, by using a custom title bar.
		// https://github.com/1j01/tracky-mouse/issues/69
		...(process.platform === 'win32' ? {
			titleBarStyle: 'hidden',
			titleBarOverlay: {
				color: 'rgb(196, 173, 235)',
				symbolColor: 'black',
				height: 32,
			},
		} : {}),
	});

	// and load the html page of the app.
	appWindow.loadFile(`src/electron-app.html`);

	// Toggle the DevTools with F12
	appWindow.webContents.on("before-input-event", (_e, input) => {
		if (input.type === "keyDown" && input.key === "F12") {
			appWindow.webContents.toggleDevTools();

			appWindow.webContents.on('devtools-opened', async () => {
				// Can't use appWindow.webContents.devToolsWebContents.on("before-input-event") - it just doesn't intercept any events.
				await appWindow.webContents.devToolsWebContents.executeJavaScript(`
					new Promise((resolve)=> {
						addEventListener("keydown", (event) => {
							if (event.key === "F12") {
								resolve();
							}
						}, { once: true });
					})
				`);
				appWindow.webContents.toggleDevTools();
			});
		}
	});

	// Restore window state, and listen for window state changes.
	appWindowState.manage(appWindow);

	// Clean up overlay when the app window is closed.
	appWindow.on('closed', () => {
		appWindow = null; // not needed if calling app.exit(), which exits immediately, but useful if calling other methods to quit
		// screenOverlayWindow?.close(); // doesn't work because screenOverlayWindow.closable is false
		// app.quit(); // doesn't work either, because screenOverlayWindow.closable is false
		stopTMDriver().catch((error) => {
			console.error('Failed to stop tm-driver before exiting:', error);
		}).finally(() => {
			app.exit(); // doesn't call beforeunload and unload listeners, or before-quit or will-quit
		});
		// Note: if re-assessing this, for macOS, make sure to handle the global shortcut, when the window doesn't exist.
	});

	let lastSentOverlayUpdateId = 0;
	let lastReceivedOverlayUpdateId = 0;
	function resetOverlayMessageThrottling() {
		// Just in case messages failed to send, which could cause the throttling code to perpetually skip updates*,
		// resetOverlayMessageThrottling pretends we're caught up, so that new messages will not be skipped by throttling.
		// *This theoretical problem doesn't actually happen even if many messages fail to send,
		// because of the mouseMove exemption from throttling.
		lastReceivedOverlayUpdateId = lastSentOverlayUpdateId;
	}
	function trySendOverlayWindowMessage(message, ...args) {
		// Could include logic to log when toggling between able and unable to update,
		// but for now it's enough to avoid errors spamming the console.
		if (!screenOverlayWindow || screenOverlayWindow.isDestroyed()) {
			// This can happen while closing the app normally.
			// console.error("No overlay window to update...");
			return;
		}
		if (screenOverlayWindow.webContents.isDestroyed()) {
			// console.error("No overlay window web contents to update...");
			return;
		}
		if (screenOverlayWindow.webContents.isCrashed()) {
			// console.error("Overlay window web contents is crashed; can't update overlay...");
			return;
		}
		if (screenOverlayWindow.webContents.isLoadingMainFrame()) {
			// This happens normally during startup.
			// console.error("Overlay window web contents is still loading; can't update overlay yet.");
			return;
		}

		// Avoid queuing too many IPC messages, which has been observed to build up incredible latency on macOS
		// (https://github.com/1j01/tracky-mouse/issues/7)
		// TODO: eventual consistency for important state like `paused`
		// Could either send the latest state after a delay if nothing else has been sent,
		// or better, send important updates immediately by diffing an "important state" object
		// (with fields like `paused` and maybe everything other than continuously changing state)
		// NOTE: If messages to the overlay window, or the acknowledgment messages in return, fail to send,
		// I theorized there could be a deadlock where the throttling code would stop sending messages entirely
		// due to counting the failed messages as still being in the queue.
		// However, due to the mouseMove exemption from throttling, even if many messages fail to send,
		// there are still new messages with new update IDs and acknowledgments that come through,
		// so lastReceivedOverlayUpdateId doesn't get stuck and updates continue.
		// This does mean that the mouseMove exemption has unintended importance that needs to be considered.

		const inQueue = lastSentOverlayUpdateId - lastReceivedOverlayUpdateId;
		// NOTE: mouseMove is exempted here because otherwise this throttling was
		// skipping too many mouseMove events, and it seems to be enough to
		// throttle just the overlayUpdate events in order to avoid the buildup of latency.
		// It could be because the overlayUpdate events have a larger JSON payload,
		// combined with similar frequency, but in principle,
		// I don't see a reason why mouseMove events couldn't incur
		// the latency buildup, and so it's possible they may
		// under heavier load or on less powerful hardware.
		// (By the way, merging the events and using differencing
		// could help or it could just make it harder to maintain this exemption.
		// Maybe not too hard as it could probably be done by property filtering.
		// But note that the exemption for mouseMove events may be crucial for avoiding deadlocks
		// in case some messages fail to send. The throttling code would have to be removed or rewritten.)
		// NOTE also: There is a behavioral/semantic difference
		// between tracking acknowledgments for any messages vs. counting only messages that are to be throttled.
		// Currently all messages are included, meaning
		// 1. extra mouseMove events can cause overlayUpdate events to be throttled.
		// 2. mouseMove events can incidentally avoid deadlocks.
		// There's also a difference between counting acknowledgments vs tracking the last acknowledged update ID.
		// Using an actual counter or a set of pending update IDs would not allow mouseMove events to incidentally avoid deadlocks.
		// Yes, I'm being a bit redundant, but I don't want to bury the complexity here.
		// The mouseMove is almost acting like a heartbeat message, doing more jobs than it was intended for.
		// Maybe if this is rewritten to use a single overlayUpdate message with differencing,
		// it will be less data and will simply not need the throttling in practice.
		// We're already relying on "smaller JSON payload = no latency buildup" for mouseMove events as far as I can tell.
		if (inQueue > 2 && message !== "mouseMove") {
			return;
		}
		lastSentOverlayUpdateId++;
		// if (failSendingNextMessages > 0) {
		// 	console.log('Simulating failure to send message');
		// 	failSendingNextMessages--;
		// 	return;
		// }
		screenOverlayWindow.webContents.send(message, lastSentOverlayUpdateId, ...args);
	}
	ipcMain.on("acknowledgeUpdate", (_event, updateId) => {
		lastReceivedOverlayUpdateId = updateId;
	});

	// Expose functionality to the renderer processes.

	// Allow controlling the mouse, but pause if the mouse is moved normally.
	const thresholdToRegainControl = 10; // in pixels
	const regainControlForTime = 2000; // in milliseconds, AFTER the mouse hasn't moved for more than mouseMoveRequestHistoryDuration milliseconds (I think)
	let regainControlTimeout = null; // also used to check if we're pausing temporarily
	let inputFeedback = {};
	let primaryDisplay = screen.getPrimaryDisplay();
	let virtualDisplayBounds = computeVirtualDisplayBounds();
	let isMultiMonitor = screen.getAllDisplays().length > 1;
	let systemMousePosition = null;
	const updateDwellClickingAndHUD = () => {
		const workAreaContainerBounds = {
			x: primaryDisplay.workArea.x - virtualDisplayBounds.x,
			y: primaryDisplay.workArea.y - virtualDisplayBounds.y,
			width: primaryDisplay.workArea.width,
			height: primaryDisplay.workArea.height,
		};
		const isManualTakeback = enabled && regainControlTimeout !== null;

		trySendOverlayWindowMessage('overlayUpdate', {
			isEnabled: enabled && !isManualTakeback,
			isManualTakeback,
			clickingMode: activeSettings.clickingMode,
			inputFeedback,
			workAreaContainerBounds,
			// Hide screen hints (added feature): when "hideScreenHints" is on,
			// suppress the yellow "Press F9..." message (but keep the functional
			// manual-takeback message) and the mouth meter under the pointer icon.
			messageText: activeSettings.hideScreenHints && !isManualTakeback ?
				"" :
				getScreenOverlayMessageText({ isManualTakeback, enabled }),
			hideInputFeedbackMeters: activeSettings.hideScreenHints === true,
			systemMousePosition,
			soundEffectsEnabled: activeSettings.soundEffects,
			// v38: recognized voice words show a yellow "!" next to the cursor
			// for one second (see hud.js in the screen overlay window).
			voiceIndicatorUntil,
			// v39: the indicator's size follows the voiceIndicatorSize setting
			// ("large" = the original, "medium" = one size smaller = default,
			// "small" = two sizes smaller, "tiny").
			voiceIndicatorSize: activeSettings.voiceIndicatorSize ?? "medium",
		});
	};

let monitorMousePositionTid = null;
	async function monitorMousePosition() {
		try {
			const pos = await getMouseLocation();
			// Convert to overlay-local CSS coordinates (subtract the overlay window's virtual origin).
			systemMousePosition = {
				x: pos.x / screenScaleFactor - virtualDisplayBounds.x,
				y: pos.y / screenScaleFactor - virtualDisplayBounds.y,
			};
		} catch (error) {
			console.error("Error getting mouse position:", error);
		}
		try {
			// Update hide-HUD-near-cursor effect
			updateDwellClickingAndHUD();
		} catch (error) {
			console.error("Error updating overlay (with new mouse position):", error);
		}
		clearTimeout(monitorMousePositionTid);
		monitorMousePositionTid = setTimeout(monitorMousePosition, 10);
	}
	monitorMousePosition();

	ipcMain.on('moveMouse', async (_event, x, y, time) => {
		// TODO: consider postponing getMouseLocation, if possible, to minimize latency,
		// perhaps separating logic for pausing/resuming camera control out from the camera control itself.
		// Update: I have done a test of extracting this. It works but note that it may change the
		// effective scale of `thresholdToRegainControl` if the frequency of mouse position measurements changes.
		// There is now the monitorMousePosition loop which could be merged with this
		// (It was this hide-HUD-near-cursor feature that had me trying extracting this, but I decided to make it a separate loop for now,
		// to preserve the behavior of `thresholdToRegainControl` and introduce the hide-HUD-near-cursor feature with minimal code changes.
		// The downside being `getMouseLocation` is called in multiple loops in parallel.)
		const curPos = await getMouseLocation();
		curPos.x /= screenScaleFactor;
		curPos.y /= screenScaleFactor;
		const clutch = applyClutch(x, y, curPos);
		// Assume any point in setMouseLocationHistory may be the latest that the mouse has been moved to,
		// since setMouseLocation is asynchronous,
		// or that getMouseLocation's result may be outdated and we've moved the mouse since then,
		// since getMouseLocation is asynchronous.
		pruneMousePosHistory();
		const distances = mousePosHistory.map(({ point }) => Math.hypot(curPos.x - point.x, curPos.y - point.y));
		const distanceMoved = distances.length ? Math.min(...distances) : 0;
		// console.log("distanceMoved", distanceMoved);
		if (distanceMoved > thresholdToRegainControl) {
			if (activeSettings.disableManualTakeback === true) {
				// Manual takeback disabled (added feature): physically moving the
				// mouse no longer steals control from head tracking. Absorb the
				// discrepancy into the history (so it doesn't retrigger every frame)
				// and let head control run this frame as usual, pulling the cursor
				// back onto the head-tracked position.
				mousePosHistory.push({ point: { x: curPos.x, y: curPos.y }, time: performance.now(), from: "moveMouse" });
			} else {
				// if (regainControlTimeout === null) {
				// 	console.log("mousePosHistory", mousePosHistory);
				// 	console.log("distances", distances);
				// 	console.log("distanceMoved", distanceMoved, ">", thresholdToRegainControl, "curPos", curPos, "last pos", mousePosHistory[mousePosHistory.length - 1], "mousePosHistory.length", mousePosHistory.length);
				// 	console.log("Pausing camera control due to manual mouse movement.");
				// }
				clearTimeout(regainControlTimeout);
				regainControlTimeout = setTimeout(() => {
					regainControlTimeout = null; // used to check if we're pausing
					// console.log("Mouse not moved for", regainControlForTime, "ms; resuming.");
					updateDwellClickingAndHUD();
				}, regainControlForTime);
				updateDwellClickingAndHUD();
				// Prevent immediately returning to manual control after switching to camera control
				// based on head movement while in manual control mode.
				// This is one of two places where we add the RETRIEVED system mouse position to `mousePosHistory`.
				// It may be a good idea to split `mousePosHistory` into two arrays,
				// say `setMouseLocationHistory` and `getMouseLocationHistory`,
				// in order to handle maintaining manual control differently from switching to manual control,
				// and/or for clarity of intent.
				mousePosHistory.push({ point: { x: curPos.x, y: curPos.y }, time: performance.now(), from: "moveMouse" });
			}
		}
		// Head → virtual gamepad sticks (added feature): independent of the
		// cursor clutch, so the sticks keep working while the cursor is parked.
		// Manual mouse takeback does NOT freeze the sticks either - moving the
		// physical mouse is a desktop action, and freezing the camera for a
		// moment every time would feel like a stutter in-game. Only the global
		// "enabled" switch (F9 / mouse mode) and game mode recenter them.
		// v30: game mode has its own switch, so the sticks follow the head even
		// while mouse mode is off (see setStickHeadPos).
		updateGamepadSticks(x, y, !enabled || !gameModeActive, virtualDisplayBounds);

		if (regainControlTimeout === null && enabled && !clutch.blocked) { // (shouldn't really get this event if enabled is false)
			// Note: there's no await here, not necessarily for a particular reason,
			// although maybe it's better to send the 'moveMouse' event as soon as possible?
			if (activeSettings.gameCameraMode === 'relativeMouse') {
				// Relative mouse mode (added feature): 3D games read the camera
				// from relative mouse movement (raw input) and ignore absolute
				// cursor placement, so inject the difference to the target as a
				// relative movement.
				const dx = Math.round(clutch.x - curPos.x);
				const dy = Math.round(clutch.y - curPos.y);
				if (dx !== 0 || dy !== 0) {
					moveMouseRelativeWithoutTracking(dx, dy).catch((error) => {
						console.error('[moveMouse] moveMouseRelative failed:', error);
					});
				}
			} else {
				setMouseLocationTracky(clutch.x, clutch.y);
			}
		}
		// const latency = performance.now() - time;
		// console.log(`moveMouse: (${x}, ${y}), latency: ${latency}, distanceMoved: ${distanceMoved}, curPos: (${curPos.x}, ${curPos.y}), lastPos: (${lastPos.x}, ${lastPos.y})`);

		// Note: name switches from "moveMouse" to "mouseMove" as it's a passive update when sent to the HUD
		// While the clutch is engaged (button up), keep the HUD on the real, frozen cursor.
		const hudX = (clutch.blocked ? curPos.x : x) - virtualDisplayBounds.x;
		const hudY = (clutch.blocked ? curPos.y : y) - virtualDisplayBounds.y;
		trySendOverlayWindowMessage('mouseMove', hudX, hudY, time);
	});

	ipcMain.on('notifyToggleState', async (_event, nowEnabled) => {
		let initialPos;
		if (nowEnabled) { // don't rely on getMouseLocation when disabling the software
			initialPos = await getMouseLocation();
			initialPos.x /= screenScaleFactor;
			initialPos.y /= screenScaleFactor;
		}
		enabled = nowEnabled;
		// Voice control (v34): keep the mirrored tracking state truthful so a
		// "关闭" heard while movement is already off stays a no-op.
		voiceControl.setTrackingState(nowEnabled);
		notifyModeState();

		// Sticks (added feature): when tracking stops, no more moveMouse events
		// arrive, so center both sticks explicitly (otherwise a game would keep
		// receiving the last stick position).
		if (!nowEnabled) {
			sendGamepadSticks(0, 0, 0, 0);
			// Touch zones (added feature): likewise release every zone key when
			// tracking stops; re-sync on the next renderer report when resumed.
			syncTouchZoneStates([]);
			// Gesture clicks (v28): the renderer stops reporting while paused;
			// drop its last report so the bound keys are released (and can't
			// stay held across a pause/resume).
			lastReportedGestures = { blink: false, mouth: false };
			syncGestureStates();
		}

		// Start immediately if enabled.
		clearTimeout(regainControlTimeout);
		regainControlTimeout = null;
		mousePosHistory.length = 0;
		if (nowEnabled) {
			// Avoid false positive for manual takeback.
			mousePosHistory.push({ point: { x: initialPos.x, y: initialPos.y }, time: performance.now(), from: "notifyToggleState" });

			// Cursor position when tracking starts (v29, reworked in v30 into a
			// choice): "center" jumps to the exact center of the display the
			// cursor is on, with the head pose at that moment as the center
			// point; "hold" never moves the cursor - it stays exactly where it
			// is (no jump, not even when clicking) and tracking continues from
			// there. Either way the residual clutch translation from the
			// previous session is dropped, since it would shift the cursor away
			// from that point, potentially into a corner.
			const recenterMode = getRecenterMode();
			cursorClutch.reset(); // v50: was clutchBlocked/clutchAnchor/clutchOffset
			const anchor = recenterMode === 'center'
				? computeRecenterPoint(initialPos)
				: { x: initialPos.x, y: initialPos.y };
			// Count the anchor as "not a manual takeover", otherwise the jump
			// would look like the user grabbed the mouse.
			mousePosHistory.push({ point: anchor, time: performance.now(), from: "notifyToggleState" });
			// Relative-mouse mode drives games from deltas and must not teleport
			// the cursor; the renderer still adopts the point as its origin.
			if (recenterMode === 'center' && activeSettings.gameCameraMode !== 'relativeMouse') {
				try {
					await setMouseLocationTracky(anchor.x, anchor.y);
				} catch (error) {
					console.error('[notifyToggleState] recenter failed:', error);
				}
			}
			appWindow?.webContents.send('pointerRecenter', Math.round(anchor.x), Math.round(anchor.y));
		}

		resetOverlayMessageThrottling();
		updateDwellClickingAndHUD();
	});
	ipcMain.on('updateInputFeedback', (_event, data) => {
		inputFeedback = data;
		updateDwellClickingAndHUD();
	});

	// Head-touch zones (added feature): the renderer reports which zones the
	// tracked nose is inside; gate on the global switch + zones clutch and
	// press/release the zone keys on edges. See syncTouchZoneStates above.
	ipcMain.on('setTouchZoneStates', (_event, ids) => {
		lastReportedTouchIds = Array.isArray(ids) ? ids.map(String) : [];
		syncTouchZoneStates(lastReportedTouchIds);
	});

	// Gesture → key bindings (added feature, v28): the renderer reports the
	// raw blink/mouth press state per frame (plus a heartbeat); gate it here
	// on the third / second clutch and the global switch, then forward
	// press/release edges to the helper as pseudo touch zones.
	ipcMain.on('setGestureStates', (_event, states) => {
		lastReportedGestures = {
			blink: !!(states && states.blink),
			mouth: !!(states && states.mouth),
		};
		syncGestureStates();
	});

	// --- Mode switching (added feature, v30) -------------------------------
	ipcMain.handle('getModeState', () => modeStatePayload());
	// Voice control (v34): renderer microphone chunks → keyword spotter.
	ipcMain.on('voiceAudio', (_event, samples) => {
		voiceControl.feedAudio(samples);
	});
	ipcMain.handle('getVoiceState', () => ({ enabled: voiceControl.isEnabled() }));

	ipcMain.on('toggleMode', (_event, mode) => {
		if (mode === 'game') {
			setGameModeActive(!gameModeActive);
		} else {
			// Mouse mode is the renderer's tracking switch.
			appWindow?.webContents.send("shortcut", "toggle-tracking");
		}
	});

	// Head position while mouse mode is off (v30): the cursor must stay put,
	// but game mode still needs the head to drive the virtual sticks.
	ipcMain.on('setStickHeadPos', (_event, x, y) => {
		if (enabled || !gameModeActive) {
			// Mouse mode is on (regular moveMouse events already carry the
			// position) or game mode is off (nothing to drive).
			return;
		}
		const nx = Number(x);
		const ny = Number(y);
		if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
			return;
		}
		updateGamepadSticks(nx, ny, false, virtualDisplayBounds);
	});


	ipcMain.on('setOptions', (_event, newOptions) => {
		const prevClutchKey = activeSettings.clutchKey;
		const prevClutchMode = activeSettings.clutchMode;
		const prevGameCameraMode = activeSettings.gameCameraMode;
		const prevSecondClutchEnabled = activeSettings.secondClutch;
		const prevSecondClutchKey = activeSettings.secondClutchKey;
		const prevSecondClutchMode = activeSettings.secondClutchMode;
		const prevThirdClutchEnabled = activeSettings.thirdClutch;
		const prevThirdClutchKey = activeSettings.thirdClutchKey;
		const prevThirdClutchMode = activeSettings.thirdClutchMode;
		const prevRightStickEnabled = activeSettings.headStickRight;
		const prevRightStickKey = activeSettings.headStickRightKey;
		const prevRightStickMode = activeSettings.headStickRightMode;
		const prevTouchZonesEnabled = activeSettings.touchZonesEnabled;
		const prevTouchZonesKey = activeSettings.touchZonesKey;
		const prevTouchZonesMode = activeSettings.touchZonesMode;
		const prevTouchZones2Key = activeSettings.touchZones2Key;
		const prevTouchZones2Mode = activeSettings.touchZones2Mode;
		const prevTouchZonesExclusive = activeSettings.touchZonesExclusive;
		const prevTouchZonesExKey = activeSettings.touchZonesExclusiveKey;
		const prevTouchZonesExMode = activeSettings.touchZonesExclusiveMode;
		const prevBridgeEnabled = activeSettings.joyconBridge;
		const prevBridgeKey = activeSettings.joyconBridgeClutchKey;
		const prevBridgeMode = activeSettings.joyconBridgeClutchMode;
		const prevJoyconGripMode = activeSettings.joyconGripMode;
		const prevStickDesktop = activeSettings.stickDesktop;
		const prevStickDesktopKey = activeSettings.stickDesktopKey;
		const prevStickDesktopMode = activeSettings.stickDesktopMode;
		const prevMouseModeKey = activeSettings.mouseModeToggleKey;
		const prevGameModeKey = activeSettings.gameModeToggleKey;
		const prevVoiceControlEnabled = activeSettings.voiceControl === true;
		// v45: tap vs hold semantics for the voice keys (captured before the
		// new options are deserialized, like the other "prev" snapshots).
		const prevVoiceKeyTapMode = activeSettings.voiceKeyTapMode === true;
		deserializeSettings(newOptions);
		saveSettings();
		// Voice control (v34): (re)build or release the keyword spotter when the
		// switch or word pair changed, and tell the renderer to start/stop
		// capturing the microphone accordingly.
		{
			const nowVoiceEnabled = activeSettings.voiceControl === true;
			voiceControl.applyConfig(activeSettings);
			// v45: tap vs hold semantics for the voice keys. Applied on every
			// options push; when the mode actually changed, drop any held
			// slots so a stale hold window doesn't outlive the semantics.
			const nowTapMode = activeSettings.voiceKeyTapMode === true;
			if (nowTapMode !== prevVoiceKeyTapMode) {
				voiceKeyHold.setTapMode(nowTapMode);
				voiceKeyHold.releaseAll();
				syncVoiceKeyStates();
				syncGestureStates();
			}
			if (nowVoiceEnabled !== prevVoiceControlEnabled) {
				appWindow?.webContents.send('voiceCapture', { enabled: nowVoiceEnabled });
				if (!nowVoiceEnabled) {
					// v38: with the mic listening gone, spoken clutch overrides
					// can no longer be refreshed or undone by speech - drop
					// them so the clutches purely follow their keys again.
					voiceClutch.reset();
					// v43: nobody is listening anymore, so a held voice key
					// would never hear its release word - release it now.
					voiceKeyHold.releaseAll();
					syncVoiceKeyStates();
				}
			}
		}
		// Mode hotkeys (v30): re-register when either key changed, and refresh
		// the settings tab bar (it shows the current keys).
		if ((activeSettings.mouseModeToggleKey !== undefined && activeSettings.mouseModeToggleKey !== prevMouseModeKey)
			|| (activeSettings.gameModeToggleKey !== undefined && activeSettings.gameModeToggleKey !== prevGameModeKey)) {
			registerModeShortcuts();
		}
		notifyModeState();
		// Restart the key watcher if the clutch key changed,
		// and reset the clutch state if the key or mode changed.
		if (activeSettings.clutchKey !== undefined && activeSettings.clutchKey !== prevClutchKey) {
			setClutchKeySpec(activeSettings.clutchKey, app);
			resetClutch();
		} else if (activeSettings.clutchMode !== undefined && activeSettings.clutchMode !== prevClutchMode) {
			resetClutch();
		}
		// Second clutch (added feature): start/stop its watcher and reset its
		// state when the enable switch, key, or mode changes.
		// (It only gates clicking, so it never touches the movement anchor.)
		if (activeSettings.secondClutch !== undefined && activeSettings.secondClutch !== prevSecondClutchEnabled) {
			secondToggleActive = false;
			if (activeSettings.secondClutch === false) {
				secondClutchWatcher.stop();
			} else {
				secondClutchWatcher.start({ app, keySpec: activeSettings.secondClutchKey || SECOND_DEFAULT_KEY_SPEC });
			}
		} else {
			if (activeSettings.secondClutchKey !== undefined && activeSettings.secondClutchKey !== prevSecondClutchKey) {
				secondClutchWatcher.setKeySpec(activeSettings.secondClutchKey, app);
				secondToggleActive = false;
			}
			if (activeSettings.secondClutchMode !== undefined && activeSettings.secondClutchMode !== prevSecondClutchMode) {
				secondToggleActive = false;
			}
		}
		// Third clutch (added feature, v28): start/stop its watcher and reset
		// its state when the enable switch, key, or mode changes. It gates the
		// blink click key binding only; the cursor is unaffected.
		{
			const thirdKey = activeSettings.thirdClutchKey || THIRD_DEFAULT_KEY_SPEC;
			const thirdMode = getThirdClutchMode();
			const thirdChanged = (activeSettings.thirdClutch !== undefined && activeSettings.thirdClutch !== (prevThirdClutchEnabled === true))
				|| (activeSettings.thirdClutchKey !== undefined && (activeSettings.thirdClutchKey || THIRD_DEFAULT_KEY_SPEC) !== (prevThirdClutchKey || THIRD_DEFAULT_KEY_SPEC))
				|| (activeSettings.thirdClutchMode !== undefined && thirdMode !== (prevThirdClutchMode === 'toggle' ? 'toggle' : 'hold'));
			if (thirdChanged) {
				thirdToggleActive = false;
				if (activeSettings.thirdClutch !== true || (thirdMode !== 'toggle' && !(activeSettings.thirdClutchKey || THIRD_DEFAULT_KEY_SPEC))) {
					// Disabled, or hold mode with no key assigned (can never
					// engage): no watcher process.
					thirdClutchWatcher.stop();
				} else {
					thirdClutchWatcher.start({ app, keySpec: thirdKey });
					thirdClutchWatcher.setKeySpec(thirdKey, app);
				}
			}
			// Re-gate the gesture clicks: any of the gesture/clutch settings
			// (or the zone table below) may have changed.
			syncGestureStates();
		}
		// Sticks (added feature): (re)start/stop each stick's clutch watcher and
		// reset its toggle state whenever its switch, key, or mode changes.
		const syncStickClutch = (watcher, prefix, prevEnabled, prevKey, prevMode, defaultKey) => {
			const enabled = activeSettings[prefix];
			const key = activeSettings[`${prefix}Key`] || defaultKey;
			const rawMode = activeSettings[`${prefix}Mode`];
			const mode = rawMode === 'toggle' ? 'toggle' : (rawMode === 'always' ? 'always' : 'hold');
			if (enabled === prevEnabled && key === (prevKey || defaultKey) && mode === prevMode) {
				return false;
			}
			if (enabled !== true || !stickClutchNeedsWatcher(mode)) {
				// Disabled, or "always" mode: no key to poll, so no watcher process.
				watcher.stop();
			} else {
				watcher.start({ app, keySpec: key });
				watcher.setKeySpec(key, app);
			}
			return true;
		};
		if (syncStickClutch(rightStickClutchWatcher, 'headStickRight', prevRightStickEnabled, prevRightStickKey, prevRightStickMode, RIGHT_STICK_DEFAULT_KEY_SPEC)) {
			rightStickToggleActive = false;
		}
		// Head-touch zones (added feature): manage both schemes' clutch watchers
		// and reset their toggle states whenever the switch, keys, or modes
		// change, then push the (possibly changed) zone → key table and re-gate
		// the live states. v22: scheme 1 keeps the original setting keys,
		// scheme 2 uses touchZones2Mode/touchZones2Key.
		{
			const manageTouchZoneClutch = (layer, prevKey, prevMode, watcher, resetToggle) => {
				const key = (layer === 2 ? activeSettings.touchZones2Key : activeSettings.touchZonesKey) || '';
				const mode = touchZoneMode(layer);
				const prevModeNorm = prevMode === 'toggle' ? 'toggle' : (prevMode === 'always' ? 'always' : 'hold');
				if (activeSettings.touchZonesEnabled !== (prevTouchZonesEnabled === true) || key !== (prevKey || '') || mode !== prevModeNorm) {
					resetToggle();
					if (activeSettings.touchZonesEnabled !== true || mode === 'always' || (mode !== 'toggle' && !key)) {
						// Disabled, "always" mode (no key), or hold mode with no key
						// assigned (can never engage): no watcher process.
						watcher.stop();
					} else {
						watcher.start({ app, keySpec: key || TOUCH_ZONES_DEFAULT_KEY_SPEC });
						watcher.setKeySpec(key || TOUCH_ZONES_DEFAULT_KEY_SPEC, app);
					}
				}
			};
			manageTouchZoneClutch(1, prevTouchZonesKey, prevTouchZonesMode, touchZonesClutchWatcher, () => {
				touchZonesToggleActive = false;
			});
			manageTouchZoneClutch(2, prevTouchZones2Key, prevTouchZones2Mode, touchZones2ClutchWatcher, () => {
				touchZones2ToggleActive = false;
			});
			// Exclusive switch (v25): manage its key watcher and reset its
			// toggle state whenever the switch, key, or mode (or the touch
			// zones' global switch) changes. It needs a watcher while both
			// switches are on; hold mode with no key can never engage.
			{
				const exEnabled = activeSettings.touchZonesExclusive === true && activeSettings.touchZonesEnabled === true;
				const exMode = touchZonesExclusiveMode();
				const exKey = activeSettings.touchZonesExclusiveKey || '';
				if (exEnabled !== (prevTouchZonesExclusive === true && prevTouchZonesEnabled === true)
					|| exKey !== (prevTouchZonesExKey || '')
					|| exMode !== (prevTouchZonesExMode === 'toggle' ? 'toggle' : 'hold')) {
					touchZonesExToggleActive = false;
					if (!exEnabled || (exMode !== 'toggle' && !exKey)) {
						touchZonesExClutchWatcher.stop();
					} else {
						touchZonesExClutchWatcher.start({ app, keySpec: exKey || TOUCH_ZONES_DEFAULT_KEY_SPEC });
						touchZonesExClutchWatcher.setKeySpec(exKey || TOUCH_ZONES_DEFAULT_KEY_SPEC, app);
					}
				}
			}
			syncTouchZonesConfig();
			syncTouchZoneStates(lastReportedTouchIds);
		}
		// Joy-Con → pad bridge (added feature): manage its clutch watcher and
		// reset its toggle state whenever its switch, key, or mode changes.
		{
			const enabled = activeSettings.joyconBridge === true;
			const key = activeSettings.joyconBridgeClutchKey || '';
			const mode = getBridgeClutchMode();
			if (enabled !== (prevBridgeEnabled === true) || key !== (prevBridgeKey || '') || mode !== getRawBridgeMode(prevBridgeMode)) {
				bridgeToggleActive = false;
				if (enabled !== true || mode === 'always' || (mode !== 'toggle' && !key)) {
					// Disabled, "always" mode (no key), or hold mode with no key
					// assigned (can never engage): no watcher process.
					joyconBridgeClutchWatcher.stop();
				} else {
					joyconBridgeClutchWatcher.start({ app, keySpec: key });
					joyconBridgeClutchWatcher.setKeySpec(key, app);
				}
			}
			syncJoyconBridge();
			// v23: push the Joy-Con grip orientation whenever it changes
			// (sendGripConfig normalizes unknown values to "vertical").
			if ((activeSettings.joyconGripMode || 'vertical') !== (prevJoyconGripMode || 'vertical')) {
				sendGripConfig(activeSettings.joyconGripMode);
			}
		}
		// Desktop stick→key mapping clutch (v27): manage its key watcher and
		// reset its toggle state whenever the switch, key, or mode changes,
		// then push the gate. "always" mode (the default) needs no key and
		// no watcher; hold mode with no key assigned can never engage.
		{
			const sdEnabled = activeSettings.stickDesktop !== false;
			const sdMode = getStickDesktopMode();
			const sdKey = activeSettings.stickDesktopKey || '';
			const prevModeNorm = prevStickDesktopMode === 'toggle' ? 'toggle' : (prevStickDesktopMode === 'always' ? 'always' : 'hold');
			if (sdEnabled !== (prevStickDesktop !== false) || sdKey !== (prevStickDesktopKey || '') || sdMode !== prevModeNorm) {
				stickDesktopToggleActive = false;
				if (!sdEnabled || sdMode === 'always' || (sdMode !== 'toggle' && !sdKey)) {
					stickDesktopClutchWatcher.stop();
				} else {
					stickDesktopClutchWatcher.start({ app, keySpec: sdKey });
					stickDesktopClutchWatcher.setKeySpec(sdKey, app);
				}
			}
			pushStickGate();
		}
		// Joy-Con key mappings (added feature): the helper runs while either
		// stick projection is enabled, or while Joy-To-Key mappings are active.
		// Push the (possibly changed) key mappings to it.
		{
			if (activeSettings.gameCameraMode !== prevGameCameraMode) {
				// Start from a clean slate when the mouse output mode switches.
				resetClutch();
			}
			const wanted = gamepadStickWanted();
			if (wanted) {
				if (startGamepadStick({ app, withPad: gamepadPadWanted() })) {
					// Fresh helper: it starts holding no keys at all, so drop
					// the gesture-key mirror and re-press whatever is still
					// wanted (the touch-zone mirror re-syncs from the
					// renderer's per-frame reports instead).
					lastGestureDown = { blink: false, mouth: false };
					syncGestureStates();
				}
				sendGamepadConfig(buildKeymapConfig());
				sendPulseConfig(activeSettings.headStickPulse !== false);
			} else if (isGamepadStickRunning()) {
				stopGamepadStick();
			}
		}
	});

	// Clutch key gamepad capture (added feature): runs the helper's
	// --capture-gamepad mode to detect buttons on any controller Windows sees.
	ipcMain.handle('captureClutchGamepad', async () => {
		return captureClutchGamepad(app);
	});
	ipcMain.on('cancelClutchGamepadCapture', () => {
		cancelClutchGamepadCapture();
	});

	ipcMain.handle('getOptions', async () => {
		return serializeSettings();
	});

	ipcMain.handle('getIsPackaged', async () => {
		return app.isPackaged;
	});

	ipcMain.handle('getCustomMenuBarModel', async () => {
		return getCustomMenuBarModel();
	});

	ipcMain.handle('invokeMenuItem', async (event, menuItemId) => {
		return invokeMenuItemById(menuItemId, BrowserWindow.fromWebContents(event.sender));
	});

	function isClickingAllowed(ignoreSecondClutch = false) {
		if (regainControlTimeout || !enabled || activeSettings.clickingMode === 'off') {
			return false;
		}

		// Second clutch (added feature, v24): facial clicking is disabled by
		// default and only allowed while the second clutch is engaged.
		// `ignoreSecondClutch` lets an in-progress button release go through
		// so a held mouse button can't get stuck down.
		if (!ignoreSecondClutch && !isSecondClutchEngaged()) {
			return false;
		}

		// Failsafe: don't click if the window(s) are closed.
		// This helps with debugging the closing/quitting behavior.
		// It would also help to have a heartbeat to avoid clicking while paused in the debugger in other scenarios,
		// and avoid the dwell clicking indicator from repeatedly showing while there's no connectivity between the processes.
		if (
			(!screenOverlayWindow || screenOverlayWindow.isDestroyed()) ||
			(!appWindow || appWindow.isDestroyed())
		) {
			return false;
		}
		return true;
	}

	function keepOverlayOnTop() {
		// In case of popup menus (app menus, context menus, or dropdown menus) opening,
		// we want to make sure the overlay stays on top.
		// This doesn't work for all cases; for example, the Ubuntu dock context menu
		// is system UI that behaves a little specially.
		// Also, for any app that is too slow to open a menu, this will not work (race condition).

		// This is disabled because it can cause the HUD to flicker.
		// It may be worth the tradeoff, but I don't want to include a "Known issues"
		// section for this, or introduce a setting for it at this time.

		// screenOverlayWindow.hide();
		// screenOverlayWindow.show();
		// setTimeout(() => {
		// 	screenOverlayWindow.hide();
		// 	screenOverlayWindow.show();
		// }, 100);
	}

	ipcMain.on('click', async (_event, x, y, _time) => {
		if (!isClickingAllowed()) {
			return;
		}

		// Translate coords in case of debug (doesn't matter when it's fullscreen).
		x += screenOverlayWindow.getContentBounds().x;
		y += screenOverlayWindow.getContentBounds().y;

		await setMouseLocationTracky(x, y);
		await click(activeSettings.swapMouseButtons ? "right" : "left");

		// const latency = performance.now() - time;
		// console.log(`click: ${x}, ${y}, latency: ${latency}`);

		keepOverlayOnTop();
	});

	// Note: buttonStates is redundant now that we do basically the same thing in the renderer process
	// TODO: consider removing it, and renaming setMouseButtonState to triggerMouseUpOrDown
	let buttonStates = {
		left: false,
		right: false,
		middle: false,
	};
	ipcMain.handle('setMouseButtonState', async (_event, button, down) => {
		// TODO: make sure the mouse button is released when disabling clicking ability
		// (including exiting the app, I suppose!)
		// Second clutch: block new presses, but always allow releases so the
		// button can't get stuck down while clicking is disabled.
		if (!isClickingAllowed( /* ignoreSecondClutch */ down !== true)) {
			return false;
		}

		let buttonName = "middle";
		if (button !== 1) {
			buttonName = (activeSettings.swapMouseButtons !== (button === 2)) ? "right" : "left";
		}
		let stateChanged = false;
		if (down) {
			if (!buttonStates[buttonName]) {
				buttonStates[buttonName] = true;
				await mouseDown(buttonName);
				stateChanged = true;
			}
		} else {
			if (buttonStates[buttonName]) {
				buttonStates[buttonName] = false;
				await mouseUp(buttonName);
				stateChanged = true;

				keepOverlayOnTop();
			}
		}

		return stateChanged;

		// const latency = performance.now() - time;
		// console.log(`click: ${x}, ${y}, latency: ${latency}`);
	});

	// Set up the screen overlay window.
	// fullscreen is needed on Windows 11, since it seems to constrain the size to the work area otherwise
	// fullscreen causes app to crash on macOS 10.14.6 with Xcode 10.3, Electron 20.0.1, Node.js 21.5.0
	// with:
	//   2026-01-18 04:58:14.966 Electron[24086:199877] *** Assertion failure in -[ElectronNSWindow titlebarAccessoryViewControllers], /BuildRoot/Library/Caches/com.apple.xbs/Sources/AppKit/AppKit-1671.60.112/AppKit.subproj/NSWindow.m:3439
	//   [0118/045815.040421:WARNING:process_memory_mac.cc(93)] mach_vm_read(0x7ffee63e9000, 0x2000): (os/kern) invalid address (1)
	// fullscreen on Linux: unknown, but previously it was enabled, so I'm leaving it as is for now.
	// For multi-monitor, fullscreen is not used since it would only cover one display; explicit bounds are used instead.
	const fullscreen = process.platform !== 'darwin' && !isMultiMonitor;
	screenOverlayWindow = new BrowserWindow({
		fullscreen,
		x: virtualDisplayBounds.x,
		y: virtualDisplayBounds.y,
		width: virtualDisplayBounds.width,
		height: virtualDisplayBounds.height,
		frame: false,
		transparent: true,
		backgroundColor: '#00000000',
		hasShadow: false,
		roundedCorners: false,
		alwaysOnTop: true,
		resizable: false,
		movable: false,
		minimizable: false,
		maximizable: false,
		closable: false,
		focusable: false,
		skipTaskbar: true,
		hiddenInMissionControl: true,
		accessibleTitle: 'yz的游戏鼠标 Screen Overlay',
		webPreferences: {
			preload: path.join(app.getAppPath(), 'src/preload-screen-overlay.js'),
		},
	});
	screenOverlayWindow.setIgnoreMouseEvents(true);
	screenOverlayWindow.setAlwaysOnTop(true, 'screen-saver');

	screenOverlayWindow.loadFile(`src/electron-screen-overlay.html`);
	screenOverlayWindow.on('close', (event) => {
		// If Windows Explorer is restarted while the app is running,
		// the Screen Overlay Window can appear in the taskbar, and become closable.
		// Various window attributes are forgotten, so we need to reset them.
		// A more proactive approach of restoring skipTaskbar when Windows Explorer is restarted would be better.
		// See: https://github.com/1j01/tracky-mouse/issues/47
		// And: https://github.com/electron/electron/issues/29526
		event.preventDefault();
		screenOverlayWindow.setSkipTaskbar(true);
		screenOverlayWindow.setClosable(false);
		if (!isMultiMonitor && process.platform !== 'darwin') {
			screenOverlayWindow.setFullScreen(true);
		} else {
			screenOverlayWindow.setFullScreen(false);
			screenOverlayWindow.setBounds(virtualDisplayBounds);
		}
		screenOverlayWindow.setIgnoreMouseEvents(true);
		// "screen-saver" is the highest level; it should show above the taskbar.
		screenOverlayWindow.setAlwaysOnTop(true, 'screen-saver');
		// The window isn't showing on top of the taskbar without this.
		screenOverlayWindow.hide();
		screenOverlayWindow.show();
	});
	screenOverlayWindow.on('closed', () => {
		screenOverlayWindow = null;
	});

	function updateDisplayConfiguration() {
		primaryDisplay = screen.getPrimaryDisplay();
		virtualDisplayBounds = computeVirtualDisplayBounds();
		isMultiMonitor = screen.getAllDisplays().length > 1;
		if (screenOverlayWindow) {
			if (!isMultiMonitor && process.platform !== 'darwin') {
				// Keep fullscreen on single-monitor (non-macOS) to ensure the overlay covers the taskbar.
			} else {
				screenOverlayWindow.setFullScreen(false);
				screenOverlayWindow.setBounds(virtualDisplayBounds);
			}
		}
		updateDwellClickingAndHUD();
		appWindow?.webContents.send('virtualDisplayBoundsChanged', virtualDisplayBounds);
	}

	screen.on('display-metrics-changed', updateDisplayConfiguration);
	screen.on('display-added', updateDisplayConfiguration);
	screen.on('display-removed', updateDisplayConfiguration);

	// screenOverlayWindow.webContents.openDevTools({ mode: 'detach' });
};

// Virtual gamepad helper (added feature): whether it's needed at all, and the
// Joy-Con key mapping config pushed to it (Joy-To-Key). Defined at module scope
// so both the settings handler and the startup path can use them.
/**
 * Whether the helper must run at all.
 *
 * Game mode features (sticks, stick→key, head touch pad, Joy-Con) need it, and
 * so do the mouse-mode gesture clicks (blink / mouth), whose keys it injects -
 * those work WITHOUT a virtual pad, which is why the helper has a padless mode.
 */
function gamepadStickWanted() {
	// Mouse mode: gesture click keys are injected by the helper (empty bindings
	// fall back to the left mouse button, so any enabled gesture click needs it).
	if (activeSettings.blinkClick === true || activeSettings.mouthClick === true) {
		return true;
	}
	// v43: voice keys inject through the same helper (padless), so any enabled
	// slot needs it too - even when no gesture click is enabled.
	if (configuredVoiceKeyZones().length > 0) {
		return true;
	}
	if (!gameModeActive) {
		return false;
	}
	if (activeSettings.headStickRight === true) {
		return true;
	}
	if (activeSettings.joyconBridge === true) {
		return true;
	}
	if (activeSettings.touchZonesEnabled === true
		&& configuredTouchZoneIds().length > 0) {
		// Touch zone keys are injected by the helper, ViGEm or not.
		return true;
	}
	if (activeSettings.joyconKeyMapEnabled !== false
		&& Array.isArray(activeSettings.joyconKeyMap)
		&& activeSettings.joyconKeyMap.length > 0) {
		return true;
	}
	return false;
}

/**
 * Whether the helper should create the virtual Xbox 360 pad (v31).
 *
 * Only game mode ever needs a pad. Everything else the helper does (key
 * injection for gesture clicks) works without one, so when game mode is off the
 * helper is started with "--no-pad --no-joycon": Windows sees no new controller
 * at launch, and nothing disappears at quit (which used to stall the system).
 */
function gamepadPadWanted() {
	return gameModeActive === true;
}

function buildKeymapConfig() {
	// v30: game mode off disables the whole mapping table. Sending it empty
	// makes the helper release any mapped key it is holding and stop
	// Joy-To-Key injection, without touching the head-touch zones (mouse mode).
	if (!gameModeActive) {
		return { keymapEnabled: false, keymap: [] };
	}
	const keymap = Array.isArray(activeSettings.joyconKeyMap)
		? activeSettings.joyconKeyMap.filter((m) => m && typeof m.btn === 'string' && typeof m.key === 'string' && m.key)
		: [];
	// Desktop head-stick direction mappings (v27): one setting key per
	// direction of the head-controlled right stick; they feed the same helper
	// mapping table as kind-"H" stick pseudo buttons.
	const headDirBtn = {
		headStickKeymapUp: 'H:stickRUp',
		headStickKeymapDown: 'H:stickRDown',
		headStickKeymapLeft: 'H:stickRLeft',
		headStickKeymapRight: 'H:stickRRight',
	};
	for (const [settingKey, btn] of Object.entries(headDirBtn)) {
		const key = activeSettings[settingKey];
		if (typeof key === 'string' && key) {
			keymap.push({ btn, key });
		}
	}
	return {
		keymapEnabled: activeSettings.joyconKeyMapEnabled !== false,
		keymap,
	};
}

// Virtual gamepad self test (added feature): stops the helper if it's running
// (the test creates its own pad), sweeps both sticks for a few seconds, then
// restores the helper. Lets the user confirm the pad works outside the app.
ipcMain.handle('runStickSelfTest', async () => {
	const wasRunning = isGamepadStickRunning();
	if (wasRunning) {
		// Force: the self test creates its own pad, so the old one has to be
		// gone before it starts (two pads would make XInput slots ambiguous).
		stopGamepadStick({ force: true });
	}
	const result = await runStickSelfTest({ app, seconds: 15 });
	if (wasRunning) {
		// Restore whatever the helper was doing before the test (pad only when
		// game mode is on - v31).
		startGamepadStick({ app, withPad: gamepadPadWanted() });
		sendGamepadConfig(buildKeymapConfig());
		sendPulseConfig(activeSettings.headStickPulse !== false);
		sendGripConfig(activeSettings.joyconGripMode);
		pushStickGate();
	}
	return result;
});

ipcMain.handle('getVirtualDisplayBounds', () => computeVirtualDisplayBounds());

installCrashRecovery({
	getAppWindow: () => appWindow,
	getScreenOverlayWindow: () => screenOverlayWindow,
});

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', async () => {
	try {
		await loadSettings();
	} catch (error) {
		// TODO: copy file to a backup location, and continue with default settings
		console.error("Failed to load settings:", error);
		dialog.showErrorBox("Failed to load settings", `Failed to load settings. The app will now quit.\n\n${error.message}`);
		app.quit();
		return;
	}
	// v47: an install coming from v46 still stores the single-syllable
	// defaults (左/右/中), which never reached 100% detection. Rewrite just
	// those three values to the two-syllable words and persist it, so the
	// settings UI and the spotter agree. A word the user picked themselves is
	// not touched.
	// v48: the single "mute the on/off pair" switch became two switches; a
	// profile that muted the pair is carried over so nothing starts firing
	// again after the upgrade.
	try {
		const wordsUpgraded = migrateKeyWordSettings47(activeSettings);
		const switchesUpgraded = migrateSchemeSwitches48(activeSettings);
		if (wordsUpgraded || switchesUpgraded) {
			await saveSettings();
		}
	} catch (error) {
		console.error("Failed to migrate voice settings:", error);
	}
	// Voice control (v34): apply the persisted switch/scheme at startup. The
	// renderer picks the initial capture state up via getVoiceState().
	voiceControl.applyConfig(activeSettings);
	// v45: apply the persisted voice-key tap/hold semantics at startup too
	// (the setOptions handler only fires when the RENDERER pushes options -
	// with nothing held at startup a plain setTapMode is enough).
	voiceKeyHold.setTapMode(activeSettings.voiceKeyTapMode === true);
	// Microphone permission (v34): the voice control needs mic access; approve
	// it for the app window instead of leaving it to Chromium's default flow.
	try {
		session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
			callback(permission === "media" || permission === "mediaKeySystem");
		});
	} catch { /* older Electron or already handled */ }
	try {
		await startTMDriver({ app });
		startLMBWatcher({ app, keySpec: activeSettings.clutchKey || DEFAULT_KEY_SPEC });
		// Second clutch (added feature): only needs its watcher while enabled.
		if (activeSettings.secondClutch !== false) {
			secondClutchWatcher.start({ app, keySpec: activeSettings.secondClutchKey || SECOND_DEFAULT_KEY_SPEC });
		}
		// Third clutch (added feature, v28): only needs its watcher while
		// enabled AND its clutch actually needs a key (hold mode with no key
		// assigned can never engage, so no watcher).
		if (activeSettings.thirdClutch === true) {
			const thirdMode = getThirdClutchMode();
			const thirdKey = activeSettings.thirdClutchKey || THIRD_DEFAULT_KEY_SPEC;
			if (thirdMode === 'toggle' || thirdKey) {
				thirdClutchWatcher.start({ app, keySpec: thirdKey });
			}
		}
		// Stick clutches (added feature): one watcher per stick, each only while
		// its stick projection is enabled AND its clutch actually needs a key
		// ("always" mode drives the stick without any key, so no watcher).
		// v19: the left stick projection is gone (replaced by the touch zones).
		if (activeSettings.headStickRight === true && stickClutchNeedsWatcher(activeSettings.headStickRightMode)) {
			rightStickClutchWatcher.start({ app, keySpec: activeSettings.headStickRightKey || RIGHT_STICK_DEFAULT_KEY_SPEC });
		}
		// Joy-Con → pad bridge clutch (added feature): only needs its watcher
		// while the bridge is enabled AND its clutch actually needs a key.
		const bridgeMode = getBridgeClutchMode();
		const bridgeKey = activeSettings.joyconBridgeClutchKey || '';
		if (activeSettings.joyconBridge === true && bridgeMode !== 'always' && bridgeKey) {
			joyconBridgeClutchWatcher.start({ app, keySpec: bridgeKey });
		}
		// Head-touch zones clutches (added feature): only need their watchers
		// while the touch keys are enabled AND the scheme's clutch actually
		// needs a key. v22: one watcher per scheme.
		for (const layer of [1, 2]) {
			const mode = touchZoneMode(layer);
			const key = (layer === 2 ? activeSettings.touchZones2Key : activeSettings.touchZonesKey) || '';
			const watcher = layer === 2 ? touchZones2ClutchWatcher : touchZonesClutchWatcher;
			if (activeSettings.touchZonesEnabled === true && mode !== 'always' && (mode === 'toggle' || key)) {
				watcher.start({ app, keySpec: key || TOUCH_ZONES_DEFAULT_KEY_SPEC });
			}
		}
		// Exclusive switch (v25): start its watcher when both switches are on.
		if (activeSettings.touchZonesEnabled === true && activeSettings.touchZonesExclusive === true) {
			const exMode = touchZonesExclusiveMode();
			const exKey = activeSettings.touchZonesExclusiveKey || '';
			if (exMode === 'toggle' || exKey) {
				touchZonesExClutchWatcher.start({ app, keySpec: exKey || TOUCH_ZONES_DEFAULT_KEY_SPEC });
			}
		}
		// Desktop stick→key mapping clutch (v27): only needs a watcher in
		// hold/toggle mode with a key assigned ("always" is the default and
		// runs without any key).
		if (activeSettings.stickDesktop !== false) {
			const sdMode = getStickDesktopMode();
			const sdKey = activeSettings.stickDesktopKey || '';
			if (sdMode !== 'always' && (sdMode === 'toggle' || sdKey)) {
				stickDesktopClutchWatcher.start({ app, keySpec: sdKey });
			}
		}
		if (gamepadStickWanted()) {
			// v31: game mode starts off, so this is normally a PADLESS helper
			// (only mouse-mode gesture clicks need it). No controller is
			// created at launch, and nothing is removed at quit.
			startGamepadStick({ app, withPad: gamepadPadWanted() });
			// Gesture clicks (v28): a freshly spawned helper holds no keys;
			// drop the mirror so still-wanted presses are re-sent.
			lastGestureDown = { blink: false, mouth: false };
			syncGestureStates();
			sendGamepadConfig(buildKeymapConfig());
			sendPulseConfig(activeSettings.headStickPulse !== false);
			// v23: push the Joy-Con grip orientation (spawn also replays the
			// last known value; this covers first-run and config loads).
			sendGripConfig(activeSettings.joyconGripMode);
			// v27: push the desktop stick-mapping gate (spawn replays it too).
			pushStickGate();
			// Push the bridge state (sendBridgeEnabled only writes when the
			// helper is alive; spawn also replays the last known value).
			syncJoyconBridge();
			// Push the touch zone → key table (spawn replays the last known
			// value too; this covers first-run and config loads).
			syncTouchZonesConfig();
		}
	} catch (error) {
		console.error("Failed to start tm-driver:", error);
		dialog.showErrorBox("Failed to start mouse driver", `Failed to start tm-driver. The app will now quit.\n\n${error.message}`);
		app.quit();
		return;
	}
	createWindow();
	// Ensure the custom menus exist when language is not set (i.e. first run)
	// This is computationally redundant when language is already set (handled in deserializeSettings)
	updateMenu();

	if (activeSettings.checkForUpdates !== false) {
		checkForUpdates({
			currentVersion: app.getVersion(),
			skippedVersion: activeSettings.skippedUpdateVersion,
			pleaseSkipThisVersion: (version) => {
				activeSettings.skippedUpdateVersion = version;
				saveSettings();
			},
			browserWindow: appWindow,
		});
	}

	updateScreenScaleFactor();
	screen.on('display-metrics-changed', (/*event, display, changedMetrics*/) => {
		updateScreenScaleFactor();
	});
	screen.on('display-added', updateScreenScaleFactor);
	screen.on('display-removed', updateScreenScaleFactor);

	// Mode hotkeys (v30): mouse mode (default F9) and game mode (default F10),
	// both user-configurable. Registering here, once the app is ready, because
	// globalShortcut is only available then. Re-registered when the keys change.
	registerModeShortcuts();
	// Debug: simulate failure sending messages to the overlay window
	// const successRegisteringF10 = globalShortcut.register('F10', () => {
	// 	console.log('Fail sending next few messages on purpose');
	// 	failSendingNextMessages = 100;
	// });
	// if (!successRegisteringF10) {
	// 	dialog.showErrorBox("Failed to register shortcut", "Failed to register global shortcut F10.");
	// }
});

app.on('before-quit', () => {
	unregisterModeShortcuts();
	stopLMBWatcher();
	secondClutchWatcher.stop();
	thirdClutchWatcher.stop();
	rightStickClutchWatcher.stop();
	joyconBridgeClutchWatcher.stop();
	touchZonesClutchWatcher.stop();
	touchZones2ClutchWatcher.stop();
	touchZonesExClutchWatcher.stop();
	stickDesktopClutchWatcher.stop();
	// v34: release the keyword spotter (and the WASM runtime backing it).
	voiceControl.stop();
	// v31: quitting - do not wait for a graceful helper exit.
	stopGamepadStick({ force: true });
	stopTMDriver().catch((error) => {
		console.error('Failed to stop tm-driver in before-quit:', error);
	});
});

app.on("second-instance", (_event, uselessCorruptedArgv, workingDirectory, additionalData) => {
	// Someone tried to run a second instance, or is trying to use the tracky-mouse CLI.
	// If there are no arguments, we should focus the app's main window.
	// If there are arguments, we should handle adjusting settings for the running app.

	// Note: the "second-instance" event sends a broken argv which may rearrange and add extra arguments,
	// so we have to use the `additionalData` object, passed from `requestSingleInstanceLock`.
	// This hack is recommended in the docs: https://www.electronjs.org/docs/api/app#event-second-instance
	console.log("second-instance", { uselessCorruptedArgv, workingDirectory, additionalData });

	// Unfortunately, it turns out `additionalData` is buggy too, and becomes null under some obscure conditions.
	// See https://github.com/electron/electron/issues/40615
	if (!additionalData) {
		// I would move this into `handleSecondInstance` and use `logToCLI`, but it won't work because `additionalData` is null.
		// logToCLI(`Command line arguments were not received by the already-running application. They are meant to be passed via additionalData, however due to a bug in Electron, additionalData === ${additionalData}. See https://github.com/electron/electron/issues/40615`);
		console.log(`second-instance: additionalData === ${additionalData}. See https://github.com/electron/electron/issues/40615`);
		return;
	}

	function deliverOutputToCLI(output) {
		console.log("second-instance: Outputting to CLI:", output);

		// Basic implementation
		// fs.writeFile(additionalData.tempFilePath, output)
		// 	.then(() => {
		// 		console.log("second-instance: Wrote output to", additionalData.tempFilePath);
		// 	}, (error) => {
		// 		console.error(`second-instance: Failed to write output to ${additionalData.tempFilePath}:`, error);
		// 	});

		// Write the file in chunks to test for race conditions.
		// const stream = require('fs').createWriteStream(additionalData.tempFilePath);
		// setTimeout(() => {
		// 	stream.write(output.slice(0, Math.floor(output.length / 2)), 'utf8', () => {
		// 		console.log("second-instance: Wrote first chunk to", additionalData.tempFilePath);
		// 		setTimeout(() => {
		// 			stream.write(output.slice(Math.floor(output.length / 2)), 'utf8', () => {
		// 				console.log("second-instance: Wrote second chunk to", additionalData.tempFilePath);
		// 				stream.end();
		// 			});
		// 		}, 2000); // Delay before writing the second chunk
		// 	});
		// }, 2000); // Delay before writing the first chunk
		// stream.on('error', (error) => {
		// 	console.error(`second-instance: Failed to write output to ${additionalData.tempFilePath}:`, error);
		// });

		// Rename the file after fully writing it to avoid race conditions.
		// Can use setTimeout to test the file polling behavior and timeout error message.
		// setTimeout(() => {
		const tempTempFilePath = additionalData.tempFilePath + ".tmp";
		fs.writeFile(tempTempFilePath, output)
			.then(() => {
				console.log("second-instance: Wrote output to", tempTempFilePath);
				fs.rename(tempTempFilePath, additionalData.tempFilePath)
					.then(() => {
						console.log("second-instance: Renamed output file to", additionalData.tempFilePath);
					}, (error) => {
						console.error(`second-instance: Failed to rename output file to ${additionalData.tempFilePath}:`, error);
					});
			}, (error) => {
				console.error(`second-instance: Failed to write output to ${tempTempFilePath}:`, error);
			});
		// }, 20000);
	}

	// `deliverOutputToCLI` has to be called exactly once.
	// If it's not called, the CLI command will show a timeout error message.
	// If it's called multiple times, only one output will be shown, or there might be an error renaming the file.
	// In order to allow many return paths in this logic, without requiring a function call before each return,
	// use an inner function (`handleSecondInstance`), and call `deliverOutputToCLI` at the end of the outer function.
	let output = "";
	function logToCLI(message) {
		output += message + "\n";
		// console.log(message);
	}
	function handleSecondInstance() {
		const argv = additionalData.arguments;
		if (argv.length === 0) {
			// TODO: DRY with `activate` event handler?
			if (BrowserWindow.getAllWindows().length === 0) {
				logToCLI("The app is likely already launching.");
			} else if (appWindow) {
				logToCLI("Focusing the existing app window.");
				if (appWindow.isMinimized()) {
					appWindow.restore();
				}
				appWindow.show();
			}
			return;
		}

		const args = parser.parse_args(argv);
		console.log("second-instance: parsed args:", args);
		// if (args.profile) {
		// 	const filePath = path.resolve(workingDirectory, args.profile[0]);
		// 	console.log("second-instance: Opening settings profile:", filePath);
		// }
		if (args.start || args.stop) {
			if (!!args.start === !!args.stop) {
				logToCLI("Exactly one of --start or --stop must be provided.");
				return;
			}
			if (!appWindow) {
				// TODO: create window if it doesn't exist (like `activate`) and make sure to start enabled
				// (but don't need to open the app for --stop)
				// (and don't focus the window if it's already open)
				logToCLI("The app window is not open.");
				return;
			}
			if (enabled !== !!args.start) {
				appWindow.webContents.send("shortcut", "toggle-tracking");
				logToCLI(`Toggled head tracking to ${enabled ? "off" : "on"}.`);
				return;
			}
			logToCLI(`Head tracking is already ${enabled ? "on" : "off"}.`);
			return;
		}
		if (args.set || args.adjust || args.get || args.profile) {
			logToCLI("Arguments not supported yet. CLI is a work in progress.");
			return;
		}
		if (args.version) {
			// This is special-cased to show both the CLI and running app versions.
			// The output from here is combined on the CLI's side.
			logToCLI(getVersion());
			return;
		}
		// logToCLI("No arguments recognized.");
		logToCLI("Happy birthday!"); // just in case
	}

	handleSecondInstance();
	deliverOutputToCLI(output);
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
// NOTE: currently exiting with app.exit()
// If re-assessing this, for macOS, make sure to handle the global shortcut, when the window doesn't exist.
app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') {
		app.quit();
	}
});

app.on('activate', () => {
	// On OS X it's common to re-create a window in the app when the
	// dock icon is clicked and there are no other windows open.
	// That said, we don't want to doubly create the window if the app is already launching,
	// and BrowserWindow.getAllWindows().length === 0 is not a sufficient check for that.
	// Currently (and I don't see a reason to change this) we don't leave the app running on macOS without a window,
	// so we don't need to handle recreating the windows.
	// if (BrowserWindow.getAllWindows().length === 0) {
	// 	createWindow();
	// }
});

// v49: the modder-credit row (General settings) opens its link in the system
// browser. Whitelisted hosts only - the renderer can never ask for an
// arbitrary URL, so a compromised renderer page can't be turned into a
// URL-opening oracle.
const OPEN_EXTERNAL_URL_PREFIXES = [
	'https://space.bilibili.com/',   // 改造人的 B 站主页
	'https://trackymouse.js.org/',   // 上游开源项目主页
];
ipcMain.handle('openExternalUrl', async (_event, url) => {
	if (typeof url !== 'string' || !OPEN_EXTERNAL_URL_PREFIXES.some((prefix) => url.startsWith(prefix))) {
		return false;
	}
	await shell.openExternal(url);
	return true;
});

ipcMain.handle('openCameraSettings', async (_event, cameraDeviceName) => {
	console.log("Requested to open camera settings for device:", cameraDeviceName);
	const { spawn } = require('child_process');
	const pathToFfmpeg = require('ffmpeg-static');
	console.log("Path to ffmpeg:", pathToFfmpeg);

	const run = (program, args) => {
		return new Promise((resolve, reject) => {
			const proc = spawn(program, args);
			let stdout = '';
			let stderr = '';
			proc.stdout.on('data', d => stdout += d);
			proc.stderr.on('data', d => stderr += d);
			proc.on('error', reject);
			proc.on('close', code => {
				resolve({ code, stdout, stderr });
			});
		});
	};

	let listDevicesResult;
	try {
		listDevicesResult = await run(pathToFfmpeg, [
			'-list_devices', 'true', '-f', 'dshow', '-i', 'dummy', '-hide_banner'
		]);
	} catch (err) {
		return { error: `Error listing devices: ${err.message}` };
	}

	console.log(`Device list output: ${listDevicesResult.stderr}`);

	if (listDevicesResult.stderr.includes("Unrecognized option 'list_devices'")) {
		return { error: `Can't show camera settings on this platform.` };
	}

	const videoDeviceRegex = /\[dshow @ [^\]]+\] "([^"]+)" \(video\)/g;
	let match;
	let deviceFound = false;

	while ((match = videoDeviceRegex.exec(listDevicesResult.stderr)) !== null) {
		const deviceName = match[1];
		console.log(`Found video device: ${deviceName}`);
		if (
			deviceName === cameraDeviceName ||
			deviceName === cameraDeviceName.replace(/\s\(.*\)$/, '')
		) {
			deviceFound = true;
			cameraDeviceName = deviceName;
			break;
		}
	}

	if (!deviceFound) {
		console.error(`Camera device "${cameraDeviceName}" not found in device list.`);
		return { error: `Camera device "${cameraDeviceName}" not found in device list.` };
	}

	console.log(`Opening settings dialog for camera device: ${cameraDeviceName}`);

	try {
		const result = await run(pathToFfmpeg, [
			'-f', 'dshow',
			'-show_video_device_dialog', 'true',
			'-i', `video=${cameraDeviceName}`
		]);
		console.log(`Command output: ${result.stderr}`);
		const dshowRegex = /\[dshow @ [^\]]+\] (.*)(Input #[\d+], dshow, .*)/g;
		// const relevantOutput = result.stderr.split('\n').filter(line => line.startsWith('[dshow @'));
		if (result.code !== 0) {
			if (result.stderr.includes('requested filter does not have a property page to show')) {
				// or shorter: "No settings found for this camera source."
				return { error: `The camera settings dialog is not available for this camera.` };
			}
			// return { error: `ffmpeg exited with code ${result.code}\n\n${result.stderr}` };
			// ffmpeg actually returns code 1 even after successfully showing the dialog.
			// check for actual arbitrary errors in the output via dshowRegex
			const match = dshowRegex.exec(result.stderr);
			if (match) {
				return { error: match[1] };
			}
		}
		// TODO: could fall back to opening ms-settings:privacy-webcam on Windows 10 and 11
		// There's also a way to link to the settings for a specific camera in Windows 11:
		// https://learn.microsoft.com/en-us/windows/apps/develop/camera/launch-camera-settings
	} catch (err) {
		console.error(`Error opening camera settings: ${err.message}`);
		return { error: `Error opening camera settings: ${err.message}` };
	}
	return { success: true };
});
