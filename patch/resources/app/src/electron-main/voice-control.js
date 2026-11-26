// Voice control (added feature, v34): offline keyword spotting.
//
// The renderer captures the microphone (it owns media permissions) and sends
// small PCM chunks over IPC; this module runs a sherpa-onnx keyword spotter
// (pure WASM, no native binary - so there is no Electron ABI concern) on the
// stream in the main process. When a keyword is recognized, the renderer is
// told to switch cursor movement on/off explicitly (NOT as a toggle, so
// saying "关闭" while movement is already off can't accidentally turn it on -
// the main process mirrors the renderer's tracking state for that).
//
// The spotter only listens for the words of the configured scheme plus the
// words of the per-feature switches that are enabled (v36), so unrelated
// speech (the model's other wake words, background talk) can't fire
// commands. Everything runs locally: no audio leaves the machine.
//
// Model: sherpa-onnx-kws-zipformer-wenetspeech (int8, ~5 MB total), keywords
// are pinyin token strings matching vendor/kws/tokens.txt (tokens verified
// present; end-to-end detection verified offline with TTS samples: 5/5 hits,
// no false triggers on unrelated speech, silence or noise).

const path = require("path");
const fs = require("fs");

// Command schemes (settings key → on/off word). Each word's pronunciation is
// written as pinyin tokens with tone marks (the model's "fpinyin" unit).
const WORD_TOKENS = {
	"开启": "k āi q ǐ",
	"关闭": "g uān b ì",
	"开始": "k āi sh ǐ",
	"停止": "t íng zh ǐ",
	"打开": "d ǎ k āi",
	// v36: words of the per-feature voice switches (fixed pairs, they don't
	// follow the scheme dropdown). Tokens verified present in tokens.txt and
	// end-to-end detection verified offline with TTS samples.
	"移动": "y í d òng",
	"静止": "j ìng zh ǐ",
	"眨眼": "zh ǎ y ǎn",
	"闭眼": "b ì y ǎn",
	"张嘴": "zh āng z uǐ",
	"闭嘴": "b ǐ z uǐ",
	// v43: voice keys. Spoken while voice control is on, each one holds a
	// user-bound key sequence down for as long as the word keeps being said
	// (see voice-key-hold.js), or clicks once in tap mode (v45).
	// v46: the words were 一/二/三 - "一" proved the weakest of the three
	// (a single syllable "yī" sits right at the edge of the KWS model: in a
	// fair A/B with the same keyword set it did not fire standalone at all
	// and only once on a tripled utterance, while "三" fired 1/1 and 3/3).
	// 左/右/中 are all longer, clearer syllables: standalone hit rate went up
	// (4/6 vs 3/6 across two TTS voices) and the false-trigger set got
	// SMALLER (negative battery 3 → 1, everyday sentences 3 → 2; the remaining
	// ones are sentences that literally contain the sound: "中间", "左右").
	"左": "z uǒ",
	"右": "y òu",
	"中": "zh ōng",
	// v46: interchangeable per-slot choices (see KEY_WORD_CHOICES). Words
	// that START with a strong consonant (z/zh/q/h/sh/x/d) fire much more
	// reliably after a pause than the semivowel "右" (yòu) - the first
	// syllable of a keyword has no left context, and a soft onset gives the
	// decoder far less to bite on.
	"前": "q ián",
	"后": "h òu",
	"上": "sh àng",
	"下": "x ià",
	"点": "d iǎn",
	// v47: two-syllable words. Every single syllable above turned out to be
	// borderline once measured properly (2 TTS voices x 6 leading-silence
	// lengths 0-4 s x 5 runs per cell): 左 42%, 中 50%, 右 67%, 三 75%,
	// 下/前/上 100%. The failures were never marginal scores - a whole
	// silence bucket would miss 5/5, repeatably, so the word simply doesn't
	// exist for the decoder at that alignment. Adding a second syllable
	// removes it entirely: 左键/右键/中键 scored 180/180 (100%) under the
	// same harness, including the two words that used to be the worst
	// (左 = 25/60, 右 = 40/60 as single syllables).
	// Structurally: the first syllable of a keyword has no left context, so a
	// one-syllable keyword has a single short window in which to cross the
	// threshold; a second syllable gives the decoder additional evidence and,
	// more importantly, a fresh onset after matching has already started.
	"左键": "z uǒ j iàn",
	"右键": "y òu j iàn",
	"中键": "zh ōng j iàn",
	"三": "s ān",
};

// v46: which words each voice-key slot may use. The spotter only ever gets
// the words actually selected (max 3 + the switch words), so a larger choice
// list costs nothing at recognition time.
// v47: the two-syllable words lead the list and are the defaults. 左/中/右
// were dropped: they are the weakest single syllables AND each one is a
// strict prefix of a two-syllable word above, so keeping them would let
// "左键" also fire the 左 slot when both are enabled.
const KEY_WORD_CHOICES = ["左键", "右键", "中键", "三", "前", "后", "上", "下", "点"];

// v47: one-time upgrade of the v46 defaults. Only exact old defaults are
// rewritten, a deliberate pick of any other word is left alone.
const LEGACY_KEY_WORDS = { "左": "左键", "右": "右键", "中": "中键" };

const VOICE_SCHEMES = {
	"kaiqi-guanbi": { onWord: "开启", offWord: "关闭" },
	"kaishi-tingzhi": { onWord: "开始", offWord: "停止" },
	"dakai-guanbi": { onWord: "打开", offWord: "关闭" },
};

// v36: per-feature voice switches. Each one listens for its own fixed pair of
// words while voice control is on (they work IN ADDITION to the scheme pair
// above): "movement" is the same cursor-movement switch as the scheme words,
// "blink"/"mouth" toggle the "Blink click" / "Open mouth click" checkboxes in
// the renderer. `setting` is the settings key that enables listening for the
// pair (defaults to on; a switch set to false is excluded from the keywords).
const VOICE_SWITCHES = {
	movement: { onWord: "移动", offWord: "静止", setting: "voiceSwitchMovement" },
	blink: { onWord: "眨眼", offWord: "闭眼", setting: "voiceSwitchBlink" },
	mouth: { onWord: "张嘴", offWord: "闭嘴", setting: "voiceSwitchMouth" },
};

// v43: voice keys (声控按键). Each enabled slot listens for its own fixed
// word while voice control is on; a recognized word means "hold the keys
// bound to this slot down while the word keeps being said" (see
// voice-key-hold.js and the "H:v1".."H:v3" pseudo zones in electron-main).
// The slot's keys are set separately (voiceKey<N>Keys, mouth-click style).
// v46: words became selectable; v47: defaults are the two-syllable words
// (左键/右键/中键) - see the measurement note above WORD_TOKENS.
const VOICE_KEYS = {
	v1: { word: "左键", wordSetting: "voiceKey1Word", setting: "voiceKey1Enabled" },
	v2: { word: "右键", wordSetting: "voiceKey2Word", setting: "voiceKey2Enabled" },
	v3: { word: "中键", wordSetting: "voiceKey3Word", setting: "voiceKey3Enabled" },
};

/** The word a slot listens for: the user's pick if valid, else the default. */
function voiceKeyWord(def, settings = {}) {
	const picked = settings[def.wordSetting];
	if (typeof picked === "string" && KEY_WORD_CHOICES.includes(picked)) {
		return picked;
	}
	// v47: a v46 default ("左"/"右"/"中") is upgraded rather than treated as
	// invalid, so an upgrade keeps working even before the settings file is
	// rewritten (electron-main persists the upgrade at startup).
	if (typeof picked === "string" && LEGACY_KEY_WORDS[picked]) {
		return LEGACY_KEY_WORDS[picked];
	}
	return def.word;
}

/**
 * v48: carry a v46/v47 master mute (voiceSwitchScheme === false) over to the
 * two per-word switches, so an upgraded profile keeps muting the same words
 * even though the single row is gone from the UI. Returns true when changed.
 */
function migrateSchemeSwitches48(settings = {}) {
	if (settings.voiceSwitchScheme === false
		&& (settings.voiceSwitchSchemeOn !== false || settings.voiceSwitchSchemeOff !== false)) {
		settings.voiceSwitchSchemeOn = false;
		settings.voiceSwitchSchemeOff = false;
		return true;
	}
	return false;
}

/**
 * v47: rewrite v46 default words to the two-syllable ones, in place.
 * Returns true when something changed, so the caller can persist it.
 * A word the user deliberately picked is never touched (only the exact v46
 * defaults are known-bad enough to be worth replacing).
 */
function migrateKeyWordSettings47(settings = {}) {
	let changed = false;
	for (const def of Object.values(VOICE_KEYS)) {
		const picked = settings[def.wordSetting];
		if (typeof picked === "string" && LEGACY_KEY_WORDS[picked]) {
			settings[def.wordSetting] = LEGACY_KEY_WORDS[picked];
			changed = true;
		}
	}
	return changed;
}

// Don't fire twice for one utterance / accidental repeat: minimum spacing
// between accepted commands. v42: only the SAME word is held back, so two
// different commands can be spoken in quick succession (say "移动" and then
// "闭嘴" right away - the second word used to be silently dropped by the
// global cooldown). A different word always goes through immediately.
const COMMAND_COOLDOWN_MS = 3000;

// Lower = more sensitive (more likely to accept an unclear utterance).
// v36: with 8 keywords active the decoder needs more beam (maxActivePaths 8)
// and a slightly lower threshold than the two-word setup of v34 - verified
// offline across 4 TTS voices (32/32 exact hits) with no false triggers on
// unrelated speech; the only sentences that fire are ones literally
// containing a keyword (e.g. "闭嘴吧，先听我说").
// v43: 11 keywords (the three voice-key digits joined) → more beam (16) and
// a slightly lower threshold (0.15) so "二" fires standalone again; the
// negative-speech battery shows the SAME false-trigger set for the 8 switch
// words as the v36 tuning, plus "一" reacting to sentences that contain a
// "一" sound - inherent to a digit keyword that common (the voice-key slots
// are opt-in per slot and default off; see the settings description).
// v46: the voice-key words are now 左/右/中 (see WORD_TOKENS) - their
// false-trigger set is SMALLER than the digits' while firing more reliably,
// so the tuning below is kept as is.
const KEYWORDS_THRESHOLD = 0.15;
const MAX_ACTIVE_PATHS = 16;

function normalizeScheme(scheme) {
	return typeof scheme === "string" && VOICE_SCHEMES[scheme] ? scheme : "kaiqi-guanbi";
}

// The commands currently listened for: the scheme pair (command "movement")
// plus every enabled switch pair. Returns [word, {command, action}] tuples -
// each word knows up front which command it belongs to and whether it means
// "on" or "off" (saying "移动" must turn movement ON even though it is not
// the scheme's own "on" word).
function activeVoiceCommands(settings = {}) {
	const { onWord, offWord } = VOICE_SCHEMES[normalizeScheme(settings.voiceControlScheme)];
	// v40: `source` tells the renderer which pair the word came from. The
	// scheme pair switches the whole tracking session on/off; the feature pair
	// ("移动"/"静止") only stops the CURSOR MOVEMENT, so clicking keeps working.
	// v46: the scheme pair can be muted on its own (voiceSwitchScheme). Words
	// like "开始"/"停止" are extremely common in ordinary speech, and until now
	// the only way to stop them from firing was to give up ALL voice control.
	// v48: split into two switches - "开始" and "停止" are muted separately,
	// because wanting to keep one and drop the other is the common case
	// ("开始" is everyday speech, "停止" is something you actually say on
	// purpose). voiceSwitchScheme stays as the master switch so a v46/v47
	// profile that muted the pair keeps muting both.
	const commands = [];
	const schemeAllowed = settings.voiceSwitchScheme !== false;
	if (schemeAllowed && settings.voiceSwitchSchemeOn !== false) {
		commands.push([onWord, { command: "movement", action: "on", source: "scheme" }]);
	}
	if (schemeAllowed && settings.voiceSwitchSchemeOff !== false) {
		commands.push([offWord, { command: "movement", action: "off", source: "scheme" }]);
	}
	for (const [id, def] of Object.entries(VOICE_SWITCHES)) {
		if (settings[def.setting] !== false) {
			commands.push([def.onWord, { command: id, action: "on", source: id }]);
			commands.push([def.offWord, { command: id, action: "off", source: id }]);
		}
	}
	// v43: voice keys. `command: "voiceKey"` + `source: "v1"/"v2"/"v3"`; the
	// renderer's router ignores these (the main process handles the hold
	// windows and key injection itself), they are here so the words land in
	// the spotter's keyword set.
	// v46: the word per slot is configurable. Two slots must never listen for
	// the same word (the spotter's word→command map is keyed by word), so the
	// first slot wins and a duplicate is skipped.
	const usedWords = new Set(commands.map(([word]) => word));
	for (const [id, def] of Object.entries(VOICE_KEYS)) {
		if (settings[def.setting] !== true) {
			continue;
		}
		const word = voiceKeyWord(def, settings);
		if (usedWords.has(word)) {
			continue;
		}
		usedWords.add(word);
		commands.push([word, { command: "voiceKey", action: "press", source: id }]);
	}
	return commands;
}

// A stable identity of the current keyword set, so a settings change that
// alters it (scheme or switch toggles) can be detected cheaply.
function voiceConfigKey(settings = {}) {
	return activeVoiceCommands(settings).map(([word]) => word).join(",");
}

function keywordsFileFor(settings) {
	return activeVoiceCommands(settings)
		.map(([word]) => `${WORD_TOKENS[word]} @${word}`)
		.join("\n");
}

/**
 * @param {object} deps
 * @param {() => string} deps.getModelDir  folder with encoder/decoder/joiner .onnx + tokens.txt
 * @param {(line: string) => void} deps.log
 * @param {(payload: {action: string, word: string, scheme: string, command: string, source: string}) => void} deps.onCommand
 *        called when a keyword is recognized (cooldown already applied; voice-key
 *        hits bypass it). command ∈ "movement"|"blink"|"mouth"|"voiceKey" - the
 *        renderer routes the first three, the main process handles "voiceKey".
 */
function createVoiceControl({ getModelDir, log, onCommand }) {
	let enabled = false;
	let scheme = "kaiqi-guanbi";
	let spotter = null;
	let spotterKey = null; // identity of the keyword set the spotter was built for
	let spotterCommands = new Map(); // word → {command, action}
	let stream = null;
	let lastCommandTime = 0;
	let lastCommandWord = null; // v42: the cooldown only holds back the same word
	let sherpa = null;
	let trackToggleState = false; // mirrored renderer tracking state: true = cursor moving
	let buildScheduled = false; // a deferred spotter build is queued
	let loading = false; // build currently running

	// v43: cheap voice-energy gate for the voice-key hold semantics (see
	// voice-key-hold.js): RMS of every incoming chunk; above threshold =
	// someone is vocalizing (a sustained "左——"). A quiet mic just means the
	// gate never opens and holds degrade to the per-hit windows - harmless.
	const SPEECH_RMS_THRESHOLD = 0.035;
	const SPEECH_HANGOVER_MS = 250;
	let speechActiveUntil = 0;

	const teardownSpotter = () => {
		if (stream) {
			try { stream.free(); } catch { /* ignore */ }
			stream = null;
		}
		if (spotter) {
			try { spotter.free(); } catch { /* ignore */ }
			spotter = null;
		}
		spotterKey = null;
		spotterCommands = new Map();
	};

	const ensureSpotter = (configKey, settings) => {
		if (spotter && spotterKey === configKey) {
			return;
		}
		teardownSpotter();
		if (!sherpa) {
			// Lazy load: the WASM runtime (~16 MB) is only parsed once voice
			// control is actually switched on, so startup stays fast.
			sherpa = require("sherpa-onnx");
		}
		const modelDir = getModelDir();
		const pick = (prefix, ext = "") => {
			// vendor files are stored under their original long names; find them
			// by prefix so a future model swap doesn't have to touch this code.
			const names = fs.readdirSync(modelDir).filter((n) => n.startsWith(prefix) && n.endsWith(".onnx"));
			if (names.length === 0) {
				throw new Error(`voice-control: missing model file "${prefix}*.onnx" in ${modelDir}`);
			}
			return path.join(modelDir, names[0]);
		};
		const commands = activeVoiceCommands(settings);
		spotterCommands = new Map(commands);
		spotter = sherpa.createKws({
			featConfig: { samplingRate: 16000, featureDim: 80 },
			modelConfig: {
				transducer: {
					encoder: pick("encoder-"),
					decoder: pick("decoder-"),
					joiner: pick("joiner-"),
				},
				tokens: path.join(modelDir, "tokens.txt"),
				numThreads: 1,
				provider: "cpu",
				debug: 0,
				modelingUnit: "fpinyin",
			},
			keywords: commands.map(([word]) => `${WORD_TOKENS[word]} @${word}`).join("\n"),
			keywordsThreshold: KEYWORDS_THRESHOLD,
			keywordsScore: 1.0,
			// 8 keywords can be active at once now (v36): the default beam of
			// 2 paths pruned rare keywords like "闭嘴" into silence.
			maxActivePaths: MAX_ACTIVE_PATHS,
			numTrailingBlanks: 1,
		});
		stream = spotter.createStream();
		spotterKey = configKey;
		const summary = commands.map(([word]) => word).join(" / ");
		log(`voice control: spotter ready (listening for: ${summary})`);
	};

	const handleHit = (result) => {
		const word = result.keyword;
		const cmd = spotterCommands.get(word);
		if (!cmd) {
			return;
		}
		const now = Date.now();
		// v43: voice-key hits bypass the cooldown entirely - the hold design
		// NEEDS the repeated hits of a continuous "一——" (each one re-arms the
		// hold window). Switch/scheme words keep the v42 same-word cooldown.
		const isVoiceKey = cmd.command === "voiceKey";
		if (!isVoiceKey && word === lastCommandWord && now - lastCommandTime < COMMAND_COOLDOWN_MS) {
			log(`voice control: ignored "${word}" (cooldown)`);
			return;
		}
		lastCommandTime = now;
		lastCommandWord = word;
		log(`voice control: heard "${word}" → ${cmd.command} ${cmd.action}`);
		// Keep the mirror accurate even if the renderer disagrees (it is the
		// source of truth and will confirm through notifyToggleState). Only the
		// scheme pair changes the tracking state - "静止" leaves tracking (and
		// therefore clicking) running (v40).
		if (cmd.command === "movement" && cmd.source === "scheme") {
			trackToggleState = cmd.action === "on";
		}
		onCommand({ action: cmd.action, word, scheme, command: cmd.command, source: cmd.source });
	};

	/**
	 * Builds the spotter off the IPC path. Loading the WASM runtime + model
	 * takes the better part of a second, which would otherwise freeze the
	 * settings window right when the user ticks the checkbox. Audio that
	 * arrives during the build is simply dropped (feedAudio no-ops).
	 */
	const scheduleBuild = (configKey, settings) => {
		if (buildScheduled) {
			return;
		}
		buildScheduled = true;
		setImmediate(() => {
			buildScheduled = false;
			if (!enabled) {
				return;
			}
			loading = true;
			try {
				ensureSpotter(configKey, settings);
			} catch (error) {
				log(`voice control: failed to load the spotter: ${error?.message || error}`);
				enabled = false;
			} finally {
				loading = false;
			}
		});
	};

	return {
		/** Apply settings (called on startup and whenever settings change). */
		applyConfig(settings = {}) {
			const nextEnabled = settings.voiceControl === true;
			const nextScheme = normalizeScheme(settings.voiceControlScheme);
			scheme = nextScheme;
			if (!nextEnabled) {
				if (enabled || spotter) {
					teardownSpotter();
					log("voice control: off");
				}
				enabled = false;
				return;
			}
			// Identity of the whole keyword set (scheme + enabled switches):
			// any settings edit that doesn't change it is a no-op here (the
			// common case).
			const configKey = voiceConfigKey(settings);
			enabled = true;
			if (spotter && spotterKey === configKey) {
				return;
			}
			// ensureSpotter() rebuilds when the keyword set changed, dropping
			// any half-heard audio along with the old keyword set.
			scheduleBuild(configKey, settings);
		},

		/** Feed a chunk of mono 16 kHz Float32 PCM from the renderer. */
		feedAudio(samples) {
			if (!enabled || !spotter || !stream || !(samples instanceof Float32Array) || samples.length === 0) {
				return;
			}
			// v43: voice-energy gate (voice-key hold extension).
			{
				let sumSquares = 0;
				for (let i = 0; i < samples.length; i++) {
					sumSquares += samples[i] * samples[i];
				}
				if (Math.sqrt(sumSquares / samples.length) >= SPEECH_RMS_THRESHOLD) {
					speechActiveUntil = Date.now() + SPEECH_HANGOVER_MS;
				}
			}
			try {
				stream.acceptWaveform(16000, samples);
				while (spotter.isReady(stream)) {
					spotter.decode(stream);
					const result = spotter.getResult(stream);
					if (result && result.keyword) {
						spotter.reset(stream);
						handleHit(result);
					}
				}
			} catch (error) {
				log(`voice control: feed error: ${error?.message || error}`);
			}
		},

		/** Renderer tracking state mirror, used to expose a truthful status. */
		setTrackingState(moving) {
			trackToggleState = moving === true;
		},
		getTrackingState() {
			return trackToggleState;
		},

		isEnabled() {
			return enabled;
		},

		/** v43: whether recent mic chunks carry voice energy (hold extension). */
		isSpeechActive() {
			return Date.now() < speechActiveUntil;
		},

		stop() {
			teardownSpotter();
			enabled = false;
		},

	// Exposed for tests.
	_schemes: VOICE_SCHEMES,
	_switches: VOICE_SWITCHES,
	_voiceKeys: VOICE_KEYS,
	_normalizeScheme: normalizeScheme,
	_activeVoiceCommands: activeVoiceCommands,
	_voiceConfigKey: voiceConfigKey,
};
}

module.exports = { createVoiceControl, VOICE_SCHEMES, VOICE_SWITCHES, VOICE_KEYS, KEY_WORD_CHOICES, LEGACY_KEY_WORDS, WORD_TOKENS, normalizeScheme, activeVoiceCommands, voiceConfigKey, voiceKeyWord, migrateKeyWordSettings47, migrateSchemeSwitches48 };
