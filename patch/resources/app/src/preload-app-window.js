// This script is injected into the MAIN APP WINDOW, before other scripts,
// with privileged access to the electron API, which it should expose in a limited way.
// That said, mouse control is pretty powerful, so it's important to keep it secure.

// TODO: enable error reporting in renderer processes
// `require("@sentry/electron/renderer")` fails due to sandboxing...
// const Sentry = require("@sentry/electron/renderer");
// Sentry.init();

const { contextBridge, ipcRenderer } = require('electron');


contextBridge.exposeInMainWorld("electronAPI", {
	moveMouse: (x, y) => {
		ipcRenderer.send('moveMouse', x, y, performance.now());
	},

	setMouseButtonState: (button, down) => {
		return ipcRenderer.invoke('setMouseButtonState', button, down);
	},

	onShortcut: (callback) => {
		const listener = (_event, data) => { callback(data); };
		ipcRenderer.on("shortcut", listener);
		return () => { ipcRenderer.removeListener("shortcut", listener); };
	},

	notifyToggleState: (nowEnabled) => {
		ipcRenderer.send('notifyToggleState', nowEnabled);
	},

	// Clutch mode: the main process pins the virtual pointer back onto the real cursor
	// while the left mouse button is up.
	onClutchPinPointer: (callback) => {
		const listener = (_event, x, y) => { callback(x, y); };
		ipcRenderer.on("clutchPinPointer", listener);
		return () => { ipcRenderer.removeListener("clutchPinPointer", listener); };
	},

	// Recenter on enable (added feature, v29): the main process reports the
	// center of the display the cursor is on when tracking is switched on, so
	// "head still" means "cursor at the exact center" instead of wherever the
	// head tracker's coordinates happen to start.
	onPointerRecenter: (callback) => {
		const listener = (_event, x, y) => { callback(x, y); };
		ipcRenderer.on("pointerRecenter", listener);
		return () => { ipcRenderer.removeListener("pointerRecenter", listener); };
	},

	// Mode switching (added feature, v30): the settings are split into "mouse
	// mode" and "game mode", each switchable with its own global hotkey. The
	// main process owns the game-mode state; the renderer only mirrors it (and
	// owns mouse mode, which is just "tracking enabled").
	getModeState: () => {
		return ipcRenderer.invoke('getModeState');
	},
	setModeState: (state) => {
		ipcRenderer.send('setModeState', state);
	},
	toggleMode: (mode) => {
		ipcRenderer.send('toggleMode', mode);
	},
	onModeState: (callback) => {
		const listener = (_event, state) => { callback(state); };
		ipcRenderer.on("modeState", listener);
		return () => { ipcRenderer.removeListener("modeState", listener); };
	},

	// Voice control (added feature, v34): the renderer captures the microphone
	// and streams PCM chunks to the main process, where the offline keyword
	// spotter runs; recognized words come back as explicit on/off commands.
	sendVoiceAudio: (samples) => {
		ipcRenderer.send('voiceAudio', samples);
	},
	getVoiceState: () => {
		return ipcRenderer.invoke('getVoiceState');
	},
	onVoiceCapture: (callback) => {
		const listener = (_event, state) => { callback(state); };
		ipcRenderer.on("voiceCapture", listener);
		return () => { ipcRenderer.removeListener("voiceCapture", listener); };
	},
	onVoiceCommand: (callback) => {
		const listener = (_event, payload) => { callback(payload); };
		ipcRenderer.on("voiceCommand", listener);
		return () => { ipcRenderer.removeListener("voiceCommand", listener); };
	},

	// Head position for the virtual sticks while mouse mode is off (added
	// feature, v30): with mouse mode off the renderer doesn't move the cursor,
	// but game mode still needs the head position to drive the sticks.
	setStickHeadPos: (x, y) => {
		ipcRenderer.send('setStickHeadPos', x, y);
	},

	// Clutch mode: capture a gamepad button via the helper (covers
	// DirectInput-class controllers the renderer's Gamepad API can't see).
	captureClutchGamepad: () => {
		return ipcRenderer.invoke('captureClutchGamepad');
	},
	cancelClutchGamepadCapture: () => {
		ipcRenderer.send('cancelClutchGamepadCapture');
	},

	// Virtual gamepad self test: sweeps both sticks so the pad can be verified
	// outside the app (browser gamepad tester, Steam, joy.cpl).
	runStickSelfTest: () => {
		return ipcRenderer.invoke('runStickSelfTest');
	},

	updateInputFeedback: (data) => {
		ipcRenderer.send('updateInputFeedback', data);
	},

	setOptions: (optionsPatch) => {
		ipcRenderer.send('setOptions', optionsPatch);
	},

	// Head-touch zones (added feature): report which zones the head is
	// currently touching (array of zone ids). The main process gates this on
	// the global switch and the zones clutch, then forwards press/release to
	// the helper executable.
	setTouchZoneStates: (ids) => {
		ipcRenderer.send('setTouchZoneStates', ids);
	},

	// Gesture → key bindings (added feature, v28): report the raw blink/mouth
	// press state ({ blink: bool, mouth: bool }). The main process gates it on
	// the third / second clutch and the global switch, then forwards press/
	// release to the helper executable (as pseudo touch zones "H:blink" /
	// "H:mouth"), which injects the user-bound key sequences.
	setGestureStates: (states) => {
		ipcRenderer.send('setGestureStates', states);
	},

	getOptions: () => {
		return ipcRenderer.invoke('getOptions');
	},

	// isPackaged: app.isPackaged, // can't require electron's app module here
	// isPackaged: !!process.defaultApp, // nope, doesn't exist
	getIsPackaged: () => ipcRenderer.invoke('getIsPackaged'),

	getPlatform: () => process.platform,

	getVirtualDisplayBounds: () => ipcRenderer.invoke('getVirtualDisplayBounds'),

	onVirtualDisplayBoundsChanged: (callback) => {
		const listener = (_event, bounds) => { callback(bounds); };
		ipcRenderer.on('virtualDisplayBoundsChanged', listener);
		return () => { ipcRenderer.removeListener('virtualDisplayBoundsChanged', listener); };
	},

	getCustomMenuBarModel: () => ipcRenderer.invoke('getCustomMenuBarModel'),

	invokeMenuItem: (menuItemId) => ipcRenderer.invoke('invokeMenuItem', menuItemId),

	onCustomMenuBarModelUpdated: (callback) => {
		const listener = (_event, model) => { callback(model); };
		ipcRenderer.on('customMenuBarModelUpdated', listener);
		return () => { ipcRenderer.removeListener('customMenuBarModelUpdated', listener); };
	},

	openCameraSettings: (deviceId) => {
		return ipcRenderer.invoke('openCameraSettings', deviceId);
	},

	// v49: open a whitelisted URL (modder credit, upstream project) in the
	// system browser. The main process validates the host, so the renderer
	// only ever gets true/false back.
	openExternalUrl: (url) => {
		return ipcRenderer.invoke('openExternalUrl', url);
	},
});
