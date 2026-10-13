/**
 * dsh-desktop-clock — browser half.
 *
 * Three contributions:
 *   1. A full-viewport background layer (z-index:-1, behind the shell's own
 *      chrome) painting the CURRENT Windows desktop wallpaper, served by this
 *      package's host half.
 *   2. A neon seven-segment clock with real depth, sized to a fraction of the
 *      viewport, centred in the app frame and portalled to `document.body`.
 *   3. On every tick, the display DISASSEMBLES AND REASSEMBLES: a segment that
 *      goes out flies across the clock and lands on a segment that is coming in,
 *      handing its light over. Which goes where is re-drawn every second.
 *
 * THE DEPTH IDEA
 * An "8" is what the display looks like with every segment present. An unlit
 * segment is therefore not switched off — it is pushed BACK, away from the
 * glass: it recedes along Z inside a per-digit perspective, shrinks slightly,
 * softens with a touch of blur, and its neon fades to a cold ghost.
 *
 * THE TRANSFER IDEA
 * Receding alone is a blink. Making the outgoing bar travel to an incoming bar's
 * slot — morphing to its size on the way — turns the same change into a
 * rearrangement: the light visibly leaves one place and arrives at another.
 *
 * The wallpaper only reaches the eye because the shell's own backdrop is made
 * translucent through the supported `theme.overrideTokens` API — a plain CSS
 * `!important` rule cannot do this, because every token here is declared
 * per colour scheme (`{ light, dark }`).
 *
 * Runtime knobs live on `window.__dshDesktopClock` and persist in localStorage.
 */
window.__ModuleLoader__.load({
	id: "dsh-desktop-clock",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		let React = require("react");
		let ReactDOM = require("react-dom");

		//#region namespace + endpoints
		const name = "dsh-desktop-clock";
		const inject = ["slots", "theme"];
		const BASE = "/dsh-desktop-clock";
		const BG_ID = "dsh-desktop-clock-bg";
		const STYLE_ID = "dsh-desktop-clock-style";
		const CONFIG_KEY = "dsh-desktop-clock:config";
		/**
		 * Bump whenever a DEFAULT changes in a way a stored config would mask.
		 *
		 * `readConfig` overlays whatever the browser saved on top of
		 * `DEFAULT_CONFIG`, so a value that used to be the default silently
		 * outranks a new one — changing the default alone does nothing for anyone
		 * who has already run the plugin once. Migrations exist for exactly that.
		 */
		const CONFIG_VERSION = 4;
		const OVERRIDE_SOURCE = "dsh-desktop-clock:wallpaper";
		const WALLPAPER_POLL_MS = 60000;

		/**
		 * Named palettes.
		 *
		 * `core` is a lit segment, `ghost` an unlit one, and the three glows are its
		 * bloom, widest last.
		 *
		 * There are two families, and the reason is measured rather than taste:
		 * `_tools/audit-ghost-contrast.mjs` shows that a near-white neon core has
		 * ~1.05 contrast against a LIGHT application panel — invisible — while any
		 * darker recess against the same panel has ~3.5, i.e. a glaring bar. The
		 * display inverts. So a light backdrop gets `ink` (dark segments on a light
		 * field, like a calculator) and a dark backdrop gets neon. `clockColor:
		 * 'auto'` picks between them from the active theme's colour scheme.
		 */
		const PALETTES = {
			ice: { core: "#E9FEFF", glow1: "#B6F1FF", glow2: "#63D6F5", glow3: "#2FA6D6", ghost: "rgba(0,0,0,0.26)", date: "rgba(214,246,255,0.88)" },
			green: { core: "#EAFFF2", glow1: "#8CFFC4", glow2: "#3BE38F", glow3: "#12A862", ghost: "rgba(0,0,0,0.26)", date: "rgba(180,255,214,0.88)" },
			amber: { core: "#FFF7E4", glow1: "#FFD98A", glow2: "#FFA726", glow3: "#C97A00", ghost: "rgba(0,0,0,0.26)", date: "rgba(255,226,168,0.88)" },
			violet: { core: "#F5EEFF", glow1: "#CDB4FF", glow2: "#8B5CF6", glow3: "#6D28D9", ghost: "rgba(0,0,0,0.26)", date: "rgba(222,203,255,0.88)" },
			ink: { core: "#16323b", glow1: "rgba(22,50,59,0.5)", glow2: "rgba(22,50,59,0.25)", glow3: "rgba(22,50,59,0.12)", ghost: "rgba(0,0,0,0.08)", date: "rgba(22,50,59,0.7)" }
		};
		const PALETTE_NAMES = ["auto", ...Object.keys(PALETTES)];

		/** `auto` follows the active theme; anything else is a palette name. */
		function resolvePalette(cfg, scheme) {
			const wanted = cfg.clockColor === "auto" ? (scheme === "light" ? "ink" : "ice") : cfg.clockColor;
			return PALETTES[wanted] ?? PALETTES.ice;
		}

		/**
		 * The palette in force, with the user's colour overrides applied.
		 *
		 * One picked glow colour is expanded into the three bloom stops by alpha.
		 * The palettes' hand-tuned multi-hue blooms (a blue-white core inside a cyan
		 * tube inside a deep-blue halo) cannot be expressed as one colour, which is
		 * exactly why the override is opt-in and an empty value means "leave the
		 * palette alone".
		 */
		function paletteFor(cfg, scheme) {
			const base = resolvePalette(cfg, scheme);
			if (!cfg.clockCore && !cfg.clockGlowColor) return base;
			const out = { ...base };
			if (cfg.clockCore) out.core = cfg.clockCore;
			const glow = cfg.clockGlowColor || cfg.clockCore;
			if (glow) {
				out.glow1 = toRgba(glow, 0.55);
				out.glow2 = toRgba(glow, 0.28);
				out.glow3 = toRgba(glow, 0.14);
			}
			return out;
		}

		/** viewBox units per CSS pixel — the digit face is 100x190 units. */
		const U = 0.78;
		const STAGE_W = 100 * U;
		const STAGE_H = 190 * U;
		/** Colon box width, and the flex gap between the eight children of the time row. */
		const COLON_W = 8 + 14;
		const TIME_GAP = 2;
		/** The whole clock at scale 1, used to fit it to the viewport. */
		const CLOCK_W = 6 * STAGE_W + 2 * COLON_W + 7 * TIME_GAP;
		/** The date row's contribution, added only when it is actually rendered. */
		const DATE_H = 26;
		const clockHeight = (showDate) => STAGE_H + (showDate ? DATE_H : 0);

		//#region shape defaults
		/**
		 * The geometry baseline, in viewBox units of the 100x190 digit face.
		 *
		 * These live ABOVE `DEFAULT_CONFIG` on purpose: the config's shape defaults
		 * are these exact values, and a `const` referenced from an initialiser that
		 * runs earlier would be a temporal-dead-zone throw at module load.
		 */
		const SEG_W = 5.2;
		const SPLIT = 2;
		const SEG_GAP = 3.2;
		//#endregion

		const DEFAULT_CONFIG = {
			background: true,
			/** Let the wallpaper through the shell's chrome. */
			transparentShell: true,
			/** How much of the theme's own backdrop colour is kept over the wallpaper. */
			canvasAlpha: 0.55,
			/** Wallpaper blur, in px. The layer is grown by the same amount so no soft edge shows. */
			backgroundBlur: 0,
			/**
			 * Frost, `0`–`1`. Not a second blur: this is the matte part of frosted
			 * glass — a fine grain laid over the wallpaper plus a mild desaturation
			 * and flattening of it, which is what separates "frosted" from "blurred".
			 */
			backgroundFrost: 0,
			clock: true,
			/** Fit the clock to the viewport instead of using `clockScale` alone. */
			autoScale: true,
			/** Target share of the viewport width. */
			clockWidth: 0.7,
			/** Hard cap on the share of the viewport height, so it can never overflow. */
			clockHeight: 0.6,
			/** Multiplier on top of the auto fit. */
			clockScale: 1,
			/** Tilt the clock toward the pointer, like a device with a gyroscope. */
			gyro: true,
			/** Maximum tilt in degrees at the viewport edge. */
			gyroStrength: 7,
			/** Maximum sideways drift in px, so the clock floats as well as tilts. */
			gyroShift: 14,
			/** Palette name. `auto` follows the theme's light/dark scheme; `ink` is the light-backdrop family. */
			clockColor: "ice",
			/**
			 * Colour overrides. Empty means "follow the palette". A glow override is
			 * expanded into the three bloom stops by alpha, because one colour is what
			 * a person can actually pick; the palettes' hand-tuned multi-hue blooms
			 * stay available by leaving this empty.
			 */
			clockCore: "",
			clockGlowColor: "",
			/**
			 * How the display rearranges when the time changes:
			 *   flow  — outgoing pieces fly to incoming slots (the default);
			 *   burst — the display detonates: pieces scatter into particles and the
			 *           new ones are assembled out of converging particles.
			 */
			animation: "flow",
			/** Particles emitted per piece, and how far they scatter, in px. */
			burstCount: 5,
			burstSpread: 90,
			// ---- shape ----------------------------------------------------------
			/** How many equal pieces one segment is cut into. */
			segSplit: SPLIT,
			/** The gap between those pieces, in viewBox units. */
			segGap: SEG_GAP,
			/** Stroke thickness, in viewBox units. */
			segWidth: SEG_W,
			/** End rounding: `1` = fully round caps, `0` = square ends. */
			endRound: 1,
			/** How far an unlit segment recedes, in px. `0` flattens the display entirely. */
			depth: 130,
			/** Camera distance for the per-digit perspective. Smaller = more dramatic shrink. */
			perspective: 700,
			/** Depth-of-field: blur added to a fully receded segment, in px. */
			depthBlur: 1.5,
			/** Recede/return/fly duration, in ms. The move is the point, so it is allowed to be slow. */
			motion: 460,
			/** Send outgoing segments flying to incoming slots instead of just receding. */
			morph: true,
			/**
			 * Page keys the clock stays off. Empty by default (show everywhere).
			 *
			 * Keys are discovery-based rather than hand-written: the panel id from
			 * `usePanelInfo` (`"conversation"`, `"plugins"`, …), and for the
			 * conversation panel a `conversation/<active tab label>` form. There is no
			 * documented id for the conversation's view tabs — the buttons carry only
			 * `role="tab"` and `aria-selected` — so the label the user is looking at is
			 * what gets recorded, and the settings page writes the key for you.
			 */
			hiddenPages: [],
			/** Share of outgoing segments that get a flight partner, `0`–`1`. */
			morphChance: 1,
			/**
			 * The dark field the digits sit on. OFF, and that is the shipped answer:
			 * a plate fixes the light-theme inversion but it is a black box in the
			 * middle of your conversation, which is worse than the problem. `clockColor:
			 * 'auto'` fixes the same inversion by switching palette instead.
			 */
			clockPanel: false,
			/** Overall fade of the whole clock, `0`–`1`. */
			clockOpacity: 1,
			/** Plate opacity, when the plate is on at all. */
			clockPanelAlpha: 0.78,
			/** Backdrop blur behind the panel; 0 disables it (blur smears the text under it). */
			clockBlur: 0,
			/** 'center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' */
			clockPosition: "center",
			/** Bloom strength multiplier on the drop-shadow radii, `0`–`2`. */
			clockGlow: 1,
			blink: true,
			showSeconds: true,
			/** The date under the digits. Off by default: the time is the point. */
			showDate: false
		};

		const CLOCK_POSITIONS = ["center", "top-left", "top-right", "bottom-left", "bottom-right"];
		const ANIMATIONS = ["flow", "burst"];
		//#endregion

		//#region config store
		function clamp(n, lo, hi, fallback) {
			const v = Number(n);
			return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
		}

		function readConfig() {
			try {
				const raw = window.localStorage.getItem(CONFIG_KEY);
				if (raw === null) return { ...DEFAULT_CONFIG };
				const parsed = JSON.parse(raw);
				if (parsed === null || typeof parsed !== "object") return { ...DEFAULT_CONFIG };
				const next = { ...DEFAULT_CONFIG };
				for (const key of Object.keys(DEFAULT_CONFIG)) {
					const value = parsed[key];
					if (Array.isArray(DEFAULT_CONFIG[key])) {
						// `typeof []` is "object", so the plain type check would happily
						// adopt a stored object here and then `.includes` would throw.
						if (Array.isArray(value)) next[key] = value.filter((v) => typeof v === "string");
						continue;
					}
					if (typeof value === typeof DEFAULT_CONFIG[key]) next[key] = value;
				}

				// v1 shipped a date line under the digits; v2 dropped it. Nothing ever
				// exposed `showDate` as a control, so a stored `true` can only be the old
				// default — never a choice — and overriding it is safe.
				if ((Number(parsed.configVersion) || 1) < 2) next.showDate = false;
				// v3 turned the backplate on. Without it the display inverts against a
				// light application theme (lit ~1.05, recess ~3.5), which is not a
				// preference a user could have expressed — the plate was not in the
				// settings UI and its old default was off.
				if ((Number(parsed.configVersion) || 1) < 3) next.clockPanel = true;
				// v4 withdrew the plate: it fixed the inversion but put a black box in
				// the middle of the conversation. The inversion is fixed by `auto`
				// palette selection instead, so the plate goes back off — including for
				// anyone the v3 migration had just turned it on for.
				if ((Number(parsed.configVersion) || 1) < 4) next.clockPanel = false;

				next.clockScale = clamp(next.clockScale, 0.2, 3, 1);
				next.clockWidth = clamp(next.clockWidth, 0.2, 1.5, DEFAULT_CONFIG.clockWidth);
				next.clockHeight = clamp(next.clockHeight, 0.2, 1.2, DEFAULT_CONFIG.clockHeight);
				next.canvasAlpha = clamp(next.canvasAlpha, 0, 1, DEFAULT_CONFIG.canvasAlpha);
				next.backgroundBlur = clamp(next.backgroundBlur, 0, 60, 0);
				next.backgroundFrost = clamp(next.backgroundFrost, 0, 1, 0);
				next.clockOpacity = clamp(next.clockOpacity, 0, 1, DEFAULT_CONFIG.clockOpacity);
				next.clockPanelAlpha = clamp(next.clockPanelAlpha, 0, 1, DEFAULT_CONFIG.clockPanelAlpha);
				next.clockBlur = clamp(next.clockBlur, 0, 60, 0);
				next.clockGlow = clamp(next.clockGlow, 0, 2, 1);
				next.burstCount = Math.round(clamp(next.burstCount, 1, 10, 5));
				next.burstSpread = clamp(next.burstSpread, 10, 300, 90);
				next.segSplit = Math.round(clamp(next.segSplit, 1, 4, SPLIT));
				next.segGap = clamp(next.segGap, 0, 10, SEG_GAP);
				next.segWidth = clamp(next.segWidth, 1.5, 12, SEG_W);
				next.endRound = clamp(next.endRound, 0, 1, 1);
				if (!ANIMATIONS.includes(next.animation)) next.animation = "flow";
				next.depth = clamp(next.depth, 0, 400, 130);
				next.perspective = clamp(next.perspective, 200, 4000, 700);
				next.depthBlur = clamp(next.depthBlur, 0, 8, 1.5);
				next.motion = clamp(next.motion, 0, 2000, 460);
				next.morphChance = clamp(next.morphChance, 0, 1, 1);
				next.gyroStrength = clamp(next.gyroStrength, 0, 24, 7);
				next.gyroShift = clamp(next.gyroShift, 0, 80, 14);
				if (!CLOCK_POSITIONS.includes(next.clockPosition)) next.clockPosition = "center";
				if (!PALETTE_NAMES.includes(next.clockColor)) next.clockColor = "auto";
				return next;
			} catch {
				return { ...DEFAULT_CONFIG };
			}
		}

		const config = { current: readConfig() };
		/**
		 * Reads the active theme's colour scheme. `apply()` replaces this with the
		 * real reader; the fallback only covers the window before that happens.
		 * `clockColor: 'auto'` depends on it — the palette has to follow light/dark
		 * because the two need opposite ink.
		 */
		let themeSchemeReader = () => "dark";
		const configListeners = new Set();

		function writeConfig(patch) {
			config.current = { ...config.current, ...patch };
			try {
				// The version rides along outside `config.current`, so it never shows up
				// as a knob in the settings page or the README table.
				window.localStorage.setItem(CONFIG_KEY, JSON.stringify({ ...config.current, configVersion: CONFIG_VERSION }));
			} catch {
				/* private mode / quota — the session still works, it just will not persist */
			}
			for (const listener of configListeners) {
				try {
					listener();
				} catch (error) {
					console.error("dsh-desktop-clock: config listener failed", error);
				}
			}
		}

		function useConfig() {
			const [, bump] = React.useState(0);
			React.useEffect(() => {
				const listener = () => bump((n) => n + 1);
				configListeners.add(listener);
				return () => configListeners.delete(listener);
			}, []);
			return config.current;
		}
		//#endregion

		//#region diagnostics
		/**
		 * The browser is the only place that knows whether the wallpaper request was
		 * authorised, or which element is painting an opaque backdrop over the
		 * layers. Fire-and-forget one line per event; the host appends it to
		 * `$DSH_HOME/.dsh-desktop-clock/diag.log`.
		 */
		function diag(stage, detail) {
			try {
				const url = `${BASE}/diag?stage=${encodeURIComponent(stage)}&detail=${encodeURIComponent(String(detail).slice(0, 900))}`;
				fetch(url, { cache: "no-store", keepalive: true }).catch(() => {});
			} catch {
				/* diagnostics must never break the clock */
			}
		}

		/**
		 * Which element actually paints the window backdrop, and what the tokens
		 * resolve to. This is the reading that decides whether a translucent
		 * `--dsw-alias-bg-base` is enough or something else is covering the layers.
		 */
		function layerReport() {
			const w = window.innerWidth;
			const h = window.innerHeight;
			const covering = [];
			for (const node of document.querySelectorAll("body *")) {
				if (covering.length >= 6) break;
				const rect = node.getBoundingClientRect();
				if (rect.width < w * 0.9 || rect.height < h * 0.9) continue;
				const bg = getComputedStyle(node).backgroundColor;
				if (bg === "" || bg === "rgba(0, 0, 0, 0)" || bg === "transparent") continue;
				covering.push(`${node.tagName}#${node.id || "-"}.${String(node.className || "-").slice(0, 28)}=${bg}`);
			}
			const bgEl = document.getElementById(BG_ID);
			const token = getComputedStyle(document.documentElement).getPropertyValue("--dsw-alias-bg-base").trim();
			return [
				`vp=${w}x${h}`,
				`token=${token || "unset"}`,
				`body=${getComputedStyle(document.body).backgroundColor}`,
				`rootBg=${getComputedStyle(document.getElementById("root")).backgroundColor}`,
				`bgEl=${bgEl === null ? "missing" : getComputedStyle(bgEl).backgroundImage.slice(0, 70)}`,
				`covering=${covering.join(" ; ") || "none"}`
			].join(" | ");
		}

		/**
		 * Any bar of the clock that has escaped the clock's own box, with the
		 * transform responsible. A blue streak crossing the application could be a
		 * mis-measured flight, a runaway scale, or something else entirely; this
		 * says which, instead of guessing.
		 */
		function escapeReport() {
			const panel = document.querySelector(".dsh-dc-panel");
			if (panel === null) return "no-clock";
			const time = panel.querySelector(".dsh-dc-time");
			if (time === null) return "no-time-row";
			const box = time.getBoundingClientRect();
			const slack = 60;
			const escaped = [];
			for (const node of time.querySelectorAll(".dsh-dc-bar")) {
				const rect = node.getBoundingClientRect();
				const over = Math.max(box.left - rect.left, rect.right - box.right, box.top - rect.top, rect.bottom - box.bottom);
				if (over <= slack) continue;
				escaped.push(
					`d${node.dataset.d}${node.dataset.s} over=${Math.round(over)} rect=${Math.round(rect.width)}x${Math.round(rect.height)} tf=${getComputedStyle(node).transform}`
				);
				if (escaped.length >= 6) break;
			}
			return [
				`timeBox=${Math.round(box.width)}x${Math.round(box.height)}`,
				`bars=${time.querySelectorAll(".dsh-dc-bar").length}`,
				`escaped=${escaped.length === 0 ? "none" : escaped.join(" | ")}`
			].join(" | ");
		}
		//#endregion

		//#region shell transparency (theme token override)
		/** `#rrggbb` / `#rgb` / `rgb()` / `rgba()` -> the same colour at `alpha`. */
		function toRgba(color, alpha) {
			if (typeof color !== "string") return null;
			const text = color.trim();
			const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
			if (hex !== null) {
				const digits = hex[1].length === 3 ? hex[1].split("").map((c) => c + c).join("") : hex[1];
				const n = parseInt(digits, 16);
				return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
			}
			const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(text);
			if (rgb !== null) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})`;
			return null;
		}

		/** The built-in backdrop per scheme, used when the active theme does not own that scheme. */
		const BUILTIN_BASE = { light: "#ffffff", dark: "#1a1a1a" };

		function resolveBase(scheme, active) {
			if (active !== null && active.colorScheme === scheme) {
				const token = active.tokens?.["--dsw-alias-bg-base"];
				if (typeof token === "string") return token;
			}
			return BUILTIN_BASE[scheme];
		}

		let overrideDispose = null;

		/**
		 * Wash the shell's two backdrop tokens at the configured alpha. Every token
		 * must be given BOTH schemes: the theme runtime picks the one in force, so
		 * a single application survives a light/dark switch.
		 */
		function applyShellTransparency(ctx) {
			const wanted = config.current.background && config.current.transparentShell;
			if (!wanted) {
				overrideDispose?.();
				overrideDispose = null;
				return;
			}
			let active = null;
			try {
				active = ctx.theme.getTheme()?.active ?? null;
			} catch {
				/* theme service not ready — the built-in bases still produce a valid wash */
			}
			const alpha = config.current.canvasAlpha;
			const wash = (scheme) => toRgba(resolveBase(scheme, active), alpha) ?? `rgba(0, 0, 0, ${alpha})`;
			const overrides = {
				"--dsw-alias-bg-base": { light: wash("light"), dark: wash("dark") },
				"--dsw-specific-sidebar-fill": { light: wash("light"), dark: wash("dark") }
			};
			const previous = overrideDispose;
			overrideDispose = ctx.theme.overrideTokens(OVERRIDE_SOURCE, overrides);
			previous?.();
		}
		//#endregion

		//#region background layer
		let backgroundEl = null;
		let frostEl = null;
		let pollTimer = null;
		let lastMtime = -1;
		let infoReported = false;

		/**
		 * A tile of fractal noise, used as the grain half of the frost effect. Kept
		 * as an inline data URI so the plugin ships no binary assets and needs no
		 * route to serve them.
		 */
		const GRAIN_URL = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)'/%3E%3C/svg%3E\")";

		function ensureBackgroundElement() {
			if (backgroundEl !== null && document.body.contains(backgroundEl)) return backgroundEl;
			backgroundEl = document.createElement("div");
			backgroundEl.id = BG_ID;
			backgroundEl.setAttribute("aria-hidden", "true");
			// `z-index:-1` as a child of <body> paints behind every in-flow element,
			// which is exactly where a wallpaper belongs.
			backgroundEl.style.cssText = "position:fixed;inset:0;z-index:-1;pointer-events:none;background-size:cover;background-position:center center;background-repeat:no-repeat;background-color:#0a0d14;";
			document.body.prepend(backgroundEl);
			return backgroundEl;
		}

		function ensureFrostElement() {
			if (frostEl !== null && document.body.contains(frostEl)) return frostEl;
			frostEl = document.createElement("div");
			frostEl.id = `${BG_ID}-frost`;
			frostEl.setAttribute("aria-hidden", "true");
			frostEl.style.cssText = `position:fixed;inset:0;z-index:-1;pointer-events:none;background-image:${GRAIN_URL};background-repeat:repeat;`;
			document.body.prepend(frostEl);
			return frostEl;
		}

		/**
		 * Blur grows the layer by its own radius so the softened edge falls outside
		 * the viewport instead of showing as a pale rim. Frost is the matte half:
		 * grain over the image plus a flattening of its own colour, which is what
		 * makes frosted glass read differently from plain blur.
		 */
		function applyBackgroundEffects() {
			const { backgroundBlur: blur, backgroundFrost: frost } = config.current;
			if (backgroundEl !== null) {
				backgroundEl.style.inset = `-${Math.ceil(blur)}px`;
				backgroundEl.style.filter =
					blur > 0 || frost > 0
						? `blur(${blur}px) saturate(${(1 - 0.35 * frost).toFixed(3)}) contrast(${(1 - 0.12 * frost).toFixed(3)})`
						: "none";
			}
			if (frost > 0.001) {
				const el = ensureFrostElement();
				el.style.opacity = (frost * 0.5).toFixed(3);
				el.style.display = "";
			} else if (frostEl !== null) {
				frostEl.style.display = "none";
			}
		}

		function applyWallpaper(info) {
			const el = ensureBackgroundElement();
			lastMtime = info.mtimeMs;
			// The mtime in the query is what actually swaps the image; the response
			// itself carries an ETag, so an unchanged wallpaper costs a 304.
			el.style.backgroundImage = `url("${info.url}?v=${info.mtimeMs}")`;
			applyBackgroundEffects();
		}

		/** Ask the host which wallpaper is current; only re-fetch the bytes if it changed. */
		async function refreshWallpaper() {
			try {
				const response = await fetch(`${BASE}/info`, { cache: "no-store" });
				if (!infoReported) {
					infoReported = true;
					diag("info", `status=${response.status} ok=${response.ok}`);
				}
				if (!response.ok) return;
				const info = await response.json();
				if (info?.ok !== true) return;
				if (info.mtimeMs !== lastMtime) applyWallpaper(info);
			} catch (error) {
				if (!infoReported) {
					infoReported = true;
					diag("info", `threw ${error?.name ?? "Error"}: ${error?.message ?? ""}`);
				}
			}
		}
		//#endregion

		//#region style
		const CSS = `
.dsh-dc-layer{position:fixed;inset:0;display:flex;pointer-events:none;z-index:2147483000;padding:28px;}
.dsh-dc-layer[data-pos="center"]{align-items:center;justify-content:center;padding:0;}
.dsh-dc-layer[data-pos="top-left"]{align-items:flex-start;justify-content:flex-start;}
.dsh-dc-layer[data-pos="top-right"]{align-items:flex-start;justify-content:flex-end;}
.dsh-dc-layer[data-pos="bottom-left"]{align-items:flex-end;justify-content:flex-start;}
.dsh-dc-layer[data-pos="bottom-right"]{align-items:flex-end;justify-content:flex-end;}
.dsh-dc-panel{position:relative;transform-origin:center center;transform-style:preserve-3d;transition:transform 300ms cubic-bezier(.22,.61,.36,1);}
.dsh-dc-panel.has-card{padding:20px 30px 14px;border-radius:22px;}
.dsh-dc-panel.has-card::after{content:'';position:absolute;inset:0;border-radius:22px;pointer-events:none;background:linear-gradient(115deg,rgba(255,255,255,.10) 0%,rgba(255,255,255,0) 44%);}
.dsh-dc-time{display:flex;align-items:center;gap:${TIME_GAP}px;overflow:clip;overflow-clip-margin:56px;}
.dsh-dc-stage{position:relative;flex:none;}
.dsh-dc-bar{position:absolute;backface-visibility:hidden;transform-origin:center center;}
/**
 * A speck of the burst. The colour set inline per speck feeds both the fill and
 * the box-shadow, so one rule serves every palette.
 *
 * The animation is driven entirely by inline custom properties: the endpoints are
 * randomised per speck, and a keyframe that reads var() can run on mount — no
 * second render is needed to move an element from its start to its end state.
 */
.dsh-dc-particle{position:absolute;border-radius:50%;pointer-events:none;background:currentColor;box-shadow:0 0 6px currentColor;will-change:transform,opacity;animation:dsh-dc-particle var(--pm, 460ms) cubic-bezier(.22,.61,.36,1) forwards;}
@keyframes dsh-dc-particle{
  from{transform:translate3d(var(--px0, 0px), var(--py0, 0px), 0) scale(1);opacity:var(--po0, 1);}
  to{transform:translate3d(var(--px1, 0px), var(--py1, 0px), 0) scale(.35);opacity:var(--po1, 0);}
}
.dsh-dc-colon{position:relative;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:24px;}
.dsh-dc-dot{display:block;border-radius:2px;}
.dsh-dc-date{margin-top:12px;text-align:center;font:500 11px/1 'Segoe UI',system-ui,-apple-system,sans-serif;letter-spacing:.34em;text-indent:.34em;text-transform:uppercase;}

.dsh-dc-settings{max-width:540px;font:400 13px/1.5 'Segoe UI',system-ui,-apple-system,sans-serif;}
.dsh-dc-settings h3{margin:0 0 4px;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary, #0f1115);}
.dsh-dc-settings .dsh-dc-sub{margin:0 0 20px;font-size:12px;color:var(--dsw-alias-label-tertiary, #81858c);}
.dsh-dc-field{margin-bottom:18px;}
.dsh-dc-field .dsh-dc-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:7px;}
.dsh-dc-field .dsh-dc-name{color:var(--dsw-alias-label-primary, #0f1115);}
.dsh-dc-field .dsh-dc-val{font:500 12px/1 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dsw-alias-label-secondary, #61666b);}
.dsh-dc-field .dsh-dc-hint{margin-top:6px;font-size:11.5px;color:var(--dsw-alias-label-tertiary, #81858c);}
.dsh-dc-warn{margin-top:8px;padding:7px 10px;border-radius:8px;font-size:11.5px;line-height:1.7;color:var(--dsw-alias-label-secondary, #61666b);background:var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08));border-left:2px solid var(--dsw-alias-brand-primary, #4d6bfe);}
.dsh-dc-field input[type=range]{width:100%;margin:0;accent-color:var(--dsw-alias-brand-primary, #4d6bfe);}
.dsh-dc-check{display:flex;align-items:center;gap:9px;cursor:pointer;color:var(--dsw-alias-label-primary, #0f1115);margin-bottom:14px;}
.dsh-dc-check input{accent-color:var(--dsw-alias-brand-primary, #4d6bfe);width:15px;height:15px;cursor:pointer;}
.dsh-dc-reset{margin-top:22px;padding:6px 14px;border-radius:8px;cursor:pointer;font:inherit;color:var(--dsw-alias-label-primary, #0f1115);background:var(--dsw-alias-button-ghost-active-fill, rgba(127,127,127,.12));border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28));}
.dsh-dc-field .dsh-dc-reset{margin-top:0;}
.dsh-dc-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;}
.dsh-dc-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;}
.dsh-dc-row input[type=color]{width:44px;height:26px;padding:0;border-radius:6px;cursor:pointer;background:transparent;border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28));}
.dsh-dc-chip-on{color:var(--dsw-alias-label-primary, #0f1115);border-color:var(--dsw-alias-brand-primary, #4d6bfe);box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary, #4d6bfe);}
.dsh-dc-chip{padding:3px 9px;border-radius:999px;cursor:pointer;font:500 11.5px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dsw-alias-label-secondary, #61666b);background:var(--dsw-alias-button-ghost-active-fill, rgba(127,127,127,.12));border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28));}
`;

		function ensureStyle() {
			let el = document.getElementById(STYLE_ID);
			if (el === null) {
				el = document.createElement("style");
				el.id = STYLE_ID;
				(document.head ?? document.documentElement).appendChild(el);
			}
			el.textContent = CSS;
		}
		//#endregion

		//#region seven-segment geometry
		/**
		 * Segment centre-lines in viewBox units (100 x 190). The horizontal bars are
		 * deliberately shorter than the full width and the verticals stop short of
		 * the bars, so every corner keeps a real gap — that separation is most of
		 * what makes the glyph look drawn rather than moulded.
		 */
		const SEGMENTS = {
			a: { x1: 26, y1: 13, x2: 74, y2: 13 },
			b: { x1: 87, y1: 26, x2: 87, y2: 82 },
			c: { x1: 87, y1: 108, x2: 87, y2: 164 },
			d: { x1: 26, y1: 177, x2: 74, y2: 177 },
			e: { x1: 13, y1: 108, x2: 13, y2: 164 },
			f: { x1: 13, y1: 26, x2: 13, y2: 82 },
			g: { x1: 26, y1: 95, x2: 74, y2: 95 }
		};
		const SEGMENT_ORDER = ["a", "b", "c", "d", "e", "f", "g"];

		/**
		 * Build the piece table for one shape configuration: every named segment cut
		 * into `split` equal pieces with `gap` viewBox units between them.
		 *
		 * The display is therefore built from `7 * split` independently addressable
		 * bars per digit instead of 7, and everything downstream — the recede, the
		 * bloom, the flight pairing, the burst — works on the pieces.
		 *
		 * That is the whole point: with 7 bars a change moves whole segments about,
		 * which reads as bars sliding. With 14 the two halves of one segment can be
		 * sent to two different destinations, so the per-second rearrangement reads
		 * as a display being taken apart and put back together.
		 */
		function buildSubsegments(split, gapUnits, widthUnits) {
			const out = [];
			const thickness = widthUnits * U;
			const gap = gapUnits * U;
			for (const key of SEGMENT_ORDER) {
				const seg = SEGMENTS[key];
				const horizontal = seg.y1 === seg.y2;
				const startAlong = (horizontal ? Math.min(seg.x1, seg.x2) : Math.min(seg.y1, seg.y2)) * U;
				const crossCentre = (horizontal ? (seg.y1 + seg.y2) / 2 : (seg.x1 + seg.x2) / 2) * U;
				const total = (horizontal ? Math.abs(seg.x2 - seg.x1) : Math.abs(seg.y2 - seg.y1)) * U;
				const piece = Math.max(1, (total - gap * (split - 1)) / split);
				for (let i = 0; i < split; i++) {
					const along = startAlong + i * (piece + gap) + piece / 2;
					out.push({
						id: `${key}${i}`,
						parent: key,
						centre: horizontal ? { x: along, y: crossCentre } : { x: crossCentre, y: along },
						box: horizontal ? { w: piece, h: thickness } : { w: thickness, h: piece }
					});
				}
			}
			return out;
		}

		/**
		 * The piece table is rebuilt only when the shape settings actually change —
		 * it is read on every render, and the burst animation makes renders frequent.
		 */
		let subCache = { key: "", value: buildSubsegments(SPLIT, SEG_GAP, SEG_W) };
		function subsegmentsFor(cfg) {
			const key = `${cfg.segSplit}|${cfg.segGap}|${cfg.segWidth}`;
			if (subCache.key !== key) subCache = { key, value: buildSubsegments(cfg.segSplit, cfg.segGap, cfg.segWidth) };
			return subCache.value;
		}

		const DIGIT_SEGMENTS = {
			"0": "abcdef",
			"1": "bc",
			"2": "abged",
			"3": "abgcd",
			"4": "fgbc",
			"5": "afgcd",
			"6": "afgecd",
			"7": "abc",
			"8": "abcdefg",
			"9": "abcdfg"
		};

		/**
		 * A gentle ease-in-out. The obvious `cubic-bezier(.22,1,.36,1)` is wrong here:
		 * being a strong ease-OUT it is already ~75% done at a fifth of the duration,
		 * which reads as a jump rather than a slide. This one lets a bar gather
		 * speed, travel, and settle.
		 */
		const EASE = "cubic-bezier(.45,.05,.15,1)";

		const h = React.createElement;

		//#region tick choreography
		/** Deterministic per-second randomness, so a re-render never reshuffles a flight. */
		function mulberry32(seed) {
			let a = seed >>> 0;
			return () => {
				a = (a + 0x6d2b79f5) >>> 0;
				let t = a;
				t = Math.imul(t ^ (t >>> 15), t | 1);
				t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
				return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
			};
		}

		function shuffle(items, rnd) {
			const out = items.slice();
			for (let i = out.length - 1; i > 0; i--) {
				const j = Math.floor(rnd() * (i + 1));
				[out[i], out[j]] = [out[j], out[i]];
			}
			return out;
		}

		/**
		 * Every tick result goes through here.
		 *
		 * This exists because it did not, once: the flight path returned
		 * `{ flights, late }` while the consumer read `tick.bursts.length`. That is
		 * a TypeError on the first second the display changes — which React's slot
		 * error boundary turns into a permanently retired entry, so the clock
		 * simply vanishes with no message anywhere. One factory means every path
		 * produces the same shape, and `check-tick-shape.mjs` enforces it.
		 */
		const makeTick = (flights = new Map(), late = new Set(), bursts = []) => ({ flights, late, bursts });

		const NO_TICK = makeTick();

		/**
		 * Work out what should happen this second.
		 *
		 * Two choreographies share the same diff:
		 *   flow  — pair every outgoing piece with an incoming one and fly it there,
		 *           morphing to the partner's shape on the way (the default);
		 *   burst — detonate: each outgoing piece throws off particles that scatter,
		 *           and each incoming piece is assembled out of particles converging
		 *           on its slot. Nothing travels between slots; the connection between
		 *           "this went out" and "that came in" is made by the particles rather
		 *           than by a flight path.
		 *
		 * Pairing is per piece, not per segment, so the two halves of one segment are
		 * free to go to two different places.
		 *
		 * `offsets` are the digit stages' layout positions, so a flight can cross
		 * from any digit to any other.
		 */
		function computeTick(second, litList, prevLit, offsets, cfg) {
			if (prevLit === null || offsets.length !== litList.length) return NO_TICK;
			const outgoing = [];
			const incoming = [];
			const pieces = subsegmentsFor(cfg);
			for (let d = 0; d < litList.length; d++) {
				const wasLit = prevLit[d] ?? "";
				const isLit = litList[d];
				for (const sub of pieces) {
					const was = wasLit.includes(sub.parent);
					const is = isLit.includes(sub.parent);
					if (was && !is) outgoing.push({ d, sub });
					else if (!was && is) incoming.push({ d, sub });
				}
			}
			if (outgoing.length === 0 && incoming.length === 0) return NO_TICK;

			if (cfg.animation === "burst") {
				// One seeded stream for the whole second, so a re-render within the same
				// second replays the identical scatter instead of re-rolling it.
				const rnd = mulberry32(second);
				const bursts = [];
				const emit = (entry, arriving) => {
					for (let k = 0; k < cfg.burstCount; k++) {
						const angle = rnd() * Math.PI * 2;
						const distance = cfg.burstSpread * (0.45 + rnd() * 0.55);
						const size = Math.max(2, Math.min(entry.sub.box.w, entry.sub.box.h) * 0.55);
						bursts.push({
							id: `${second}:${entry.d}:${entry.sub.id}:${arriving ? "in" : "out"}:${k}`,
							digit: entry.d,
							x: entry.sub.centre.x,
							y: entry.sub.centre.y,
							size,
							dx: Math.cos(angle) * distance,
							dy: Math.sin(angle) * distance,
							arriving
						});
					}
				};
				for (const entry of outgoing) emit(entry, false);
				for (const entry of incoming) emit(entry, true);
				return makeTick(new Map(), new Set(), bursts);
			}

			if (!cfg.morph) return NO_TICK;
			if (outgoing.length === 0 || incoming.length === 0) return NO_TICK;

			const rnd = mulberry32(second);
			const sources = shuffle(outgoing, rnd);
			const targets = shuffle(incoming, rnd);
			const pairs = Math.round(Math.min(sources.length, targets.length) * cfg.morphChance);

			const flights = new Map();
			const late = new Set();
			// A flight is only ever between two slots of the same clock, so a
			// displacement larger than the whole face means the measurement is wrong.
			// Degrading to "no flight" is always better than a bar crossing the app.
			const limit = CLOCK_W * 1.5;
			const rejected = [];
			for (let i = 0; i < pairs; i++) {
				const from = sources[i];
				const to = targets[i];
				const fromOffset = offsets[from.d];
				const toOffset = offsets[to.d];
				if (fromOffset === undefined || toOffset === undefined) continue;
				const a = from.sub.centre;
				const b = to.sub.centre;
				const dx = toOffset.x + b.x - (fromOffset.x + a.x);
				const dy = toOffset.y + b.y - (fromOffset.y + a.y);
				if (Math.abs(dx) > limit || Math.abs(dy) > limit) {
					rejected.push(`${from.d}${from.sub.id}->${to.d}${to.sub.id}:${Math.round(dx)},${Math.round(dy)}`);
					continue;
				}
				flights.set(`${from.d}:${from.sub.id}`, {
					dx,
					dy,
					sx: to.sub.box.w / from.sub.box.w,
					sy: to.sub.box.h / from.sub.box.h
				});
				late.add(`${to.d}:${to.sub.id}`);
			}
			if (rejected.length > 0) diag("flight-rejected", rejected.join(" "));
			return makeTick(flights, late);
		}
		//#endregion

		/**
		 * The bloom, in three states that all spell out the same four functions in
		 * the same order — blur() then three drop-shadow()s — because CSS
		 * interpolates filter lists position by position and cannot tween between
		 * differently-shaped lists.
		 *
		 *   lit     — crisp, full bloom;
		 *   flight  — a light in mid-air: a touch of motion blur, most of the bloom;
		 *   receded — depth-of-field blur, bloom collapsed to nothing.
		 */
		function barFilter(mode, palette, cfg) {
			const g = cfg.clockGlow;
			const blur = mode === "lit" ? "0px" : mode === "flight" ? "0.6px" : `${cfg.depthBlur.toFixed(2)}px`;
			const d = (n) => (mode === "receded" ? "0px" : `${(n * g).toFixed(1)}px`);
			const bloom = (a, b, c) =>
				`drop-shadow(0 0 ${d(a)} ${palette.glow1}) drop-shadow(0 0 ${d(b)} ${palette.glow2}) drop-shadow(0 0 ${d(c)} ${palette.glow3})`;
			if (mode === "lit") return `blur(${blur}) ${bloom(2.5, 9, 26)}`;
			if (mode === "flight") return `blur(${blur}) ${bloom(1.8, 6, 14)}`;
			return `blur(${blur}) ${bloom(2.5, 9, 26)}`;
		}

		/**
		 * One piece of one segment. Three states share a single transition:
		 *   flying  — displaced to a partner slot, morphed to its shape, dimming;
		 *   lit     — at the glass, full neon;
		 *   receded — pushed back, cold and soft.
		 */
		function SegBar({ sub, lit, flight, lateLit, digitIndex, palette, cfg }) {
			const m = cfg.motion;
			// A bar receiving a flight waits for it to arrive before lighting up.
			const delay = lateLit ? Math.round(m * 0.55) : 0;
			// In burst mode the leaving piece is being replaced by its own particles, so
			// it should get out of the way rather than linger for the full duration.
			const leaving = !lit && flight === undefined;
			const duration = lateLit
				? Math.max(120, Math.round(m * 0.5))
				: leaving && cfg.animation === "burst"
					? Math.max(90, Math.round(m * 0.4))
					: m;
			const timing = `${duration}ms ${EASE} ${delay}ms`;

			let transform;
			let background;
			let filter;
			if (flight !== undefined) {
				transform = `translate3d(${flight.dx.toFixed(1)}px, ${flight.dy.toFixed(1)}px, 0px) scaleX(${flight.sx.toFixed(3)}) scaleY(${flight.sy.toFixed(3)})`;
				// A bar in mid-air is a light in motion, so it stays bright — it does
				// not darken toward the recess colour until it lands.
				background = toRgba(palette.core, 0.82);
				filter = barFilter("flight", palette, cfg);
			} else if (lit) {
				transform = "translate3d(0, 0, 0px)";
				background = palette.core;
				filter = barFilter("lit", palette, cfg);
			} else {
				transform = `translate3d(0, 0, ${-cfg.depth}px)`;
				background = palette.ghost;
				filter = barFilter("receded", palette, cfg);
			}

			return h("div", {
				className: "dsh-dc-bar",
				"data-d": String(digitIndex),
				"data-s": sub.id,
				style: {
					left: `${(sub.centre.x - sub.box.w / 2).toFixed(2)}px`,
					top: `${(sub.centre.y - sub.box.h / 2).toFixed(2)}px`,
					width: `${sub.box.w.toFixed(2)}px`,
					height: `${sub.box.h.toFixed(2)}px`,
					borderRadius: `${(Math.min(sub.box.w, sub.box.h) / 2 * cfg.endRound).toFixed(2)}px`,
					background,
					filter,
					transform,
					transition: `transform ${timing}, background-color ${timing}, filter ${timing}`
				}
			});
		}

		/**
		 * One speck of the detonation. Rendered inside the digit's own stage so it
		 * inherits that digit's perspective, and animated entirely from CSS custom
		 * properties: the endpoints are random per speck, and a keyframe reading
		 * `var()` runs on mount without React having to flip anything on a second
		 * frame.
		 *
		 * An outgoing speck starts at the piece and flies out; an incoming one starts
		 * far away and converges on the piece. Same keyframe, swapped endpoints.
		 */
		function Particle({ burst, palette, cfg }) {
			const half = burst.size / 2;
			const out = `${burst.dx.toFixed(1)}px`;
			const outY = `${burst.dy.toFixed(1)}px`;
			return h("span", {
				className: "dsh-dc-particle",
				style: {
					left: `${(burst.x - half).toFixed(2)}px`,
					top: `${(burst.y - half).toFixed(2)}px`,
					width: `${burst.size.toFixed(2)}px`,
					height: `${burst.size.toFixed(2)}px`,
					color: palette.core,
					"--px0": burst.arriving ? out : "0px",
					"--py0": burst.arriving ? outY : "0px",
					"--po0": burst.arriving ? 0 : 1,
					"--px1": burst.arriving ? "0px" : out,
					"--py1": burst.arriving ? "0px" : outY,
					"--po1": burst.arriving ? 1 : 0,
					"--pm": `${cfg.motion}ms`
				}
			});
		}

		/**
		 * One digit: `7 * segSplit` pieces sharing a perspective, so each recedes
		 * toward its own cell centre. Every piece of a segment is lit together — the
		 * split is a shape and a choreography, not an extra thing to decode.
		 */
		function Digit({ value, digitIndex, palette, cfg, tick }) {
			const lit = DIGIT_SEGMENTS[value] ?? "";
			// `?? []` even though makeTick guarantees the key: this dereference sits
			// directly on the path that silently kills the whole overlay, and a
			// missing entry must degrade to "no particles", never to a crash.
			const bursts = tick.bursts ?? [];
			return h(
				"div",
				{
					className: "dsh-dc-stage",
					style: { width: `${STAGE_W.toFixed(2)}px`, height: `${STAGE_H.toFixed(2)}px`, perspective: `${cfg.perspective}px` }
				},
				subsegmentsFor(cfg).map((sub) =>
					h(SegBar, {
						key: sub.id,
						sub,
						lit: lit.includes(sub.parent),
						flight: tick.flights.get(`${digitIndex}:${sub.id}`),
						lateLit: tick.late.has(`${digitIndex}:${sub.id}`),
						digitIndex,
						palette,
						cfg
					})
				),
				bursts.length === 0
					? null
					: bursts.map((burst) => (burst.digit === digitIndex ? h(Particle, { key: burst.id, burst, palette, cfg }) : null))
			);
		}

		/** The separator: two dots that recede exactly like a segment does. */
		function Colon({ on, palette, cfg }) {
			const size = 8;
			const receded = !on;
			const z = receded ? -cfg.depth * 0.75 : 0;
			const dot = h("span", {
				className: "dsh-dc-dot",
				style: {
					width: `${size}px`,
					height: `${size}px`,
					background: on ? palette.core : palette.ghost,
					filter: barFilter(on ? "lit" : "receded", palette, cfg),
					transform: `translate3d(0, 0, ${z}px)`,
					transition: `transform ${cfg.motion}ms ${EASE}, background-color ${cfg.motion}ms ${EASE}, filter ${cfg.motion}ms ${EASE}`
				}
			});
			return h(
				"div",
				{ className: "dsh-dc-colon", style: { width: `${COLON_W}px`, height: `${STAGE_H.toFixed(2)}px`, perspective: `${cfg.perspective}px` } },
				dot,
				dot
			);
		}
		//#endregion

		//#region clock
		/**
		 * Wall-clock time that re-arms itself against the next real second boundary,
		 * so the display never drifts the way a bare 1000 ms interval does.
		 */
		function useNow(enabled) {
			const [now, setNow] = React.useState(() => new Date());
			React.useEffect(() => {
				if (!enabled) return undefined;
				let timer = null;
				const tick = () => {
					setNow(new Date());
					timer = window.setTimeout(tick, 1000 - (Date.now() % 1000));
				};
				timer = window.setTimeout(tick, 1000 - (Date.now() % 1000));
				return () => {
					if (timer !== null) window.clearTimeout(timer);
				};
			}, [enabled]);
			return now;
		}

		/** Viewport size, coalesced to one update per frame. */
		function useViewport() {
			const [size, setSize] = React.useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
			React.useEffect(() => {
				let frame = null;
				const onResize = () => {
					if (frame !== null) return;
					frame = window.requestAnimationFrame(() => {
						frame = null;
						setSize({ w: window.innerWidth, h: window.innerHeight });
					});
				};
				window.addEventListener("resize", onResize);
				return () => {
					window.removeEventListener("resize", onResize);
					if (frame !== null) window.cancelAnimationFrame(frame);
				};
			}, []);
			return size;
		}

		/** Normalised pointer position, coalesced to one update per frame. */
		function usePointer() {
			const [point, setPoint] = React.useState({ x: 0.5, y: 0.5 });
			React.useEffect(() => {
				let frame = null;
				let pending = null;
				const flush = () => {
					frame = null;
					if (pending !== null) {
						setPoint(pending);
						pending = null;
					}
				};
				const onMove = (event) => {
					pending = { x: event.clientX / window.innerWidth, y: event.clientY / window.innerHeight };
					if (frame === null) frame = window.requestAnimationFrame(flush);
				};
				window.addEventListener("pointermove", onMove, { passive: true });
				return () => {
					window.removeEventListener("pointermove", onMove);
					if (frame !== null) window.cancelAnimationFrame(frame);
				};
			}, []);
			return point;
		}

		/** Honouring the OS setting is not optional for a purely decorative motion. */
		function usePrefersReducedMotion() {
			const [reduced, setReduced] = React.useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
			React.useEffect(() => {
				const query = window.matchMedia("(prefers-reduced-motion: reduce)");
				const onChange = () => setReduced(query.matches);
				query.addEventListener("change", onChange);
				return () => query.removeEventListener("change", onChange);
			}, []);
			return reduced;
		}

		const pad = (n) => String(n).padStart(2, "0");

		/**
		 * The conversation's view tabs expose no id — the buttons carry only
		 * `role="tab"` and `aria-selected` — so the active tab is identified by the
		 * label the user is actually looking at. That is why page keys are recorded
		 * from the live UI instead of being a hand-written list.
		 */
		function readActiveTabLabel() {
			try {
				const node = document.querySelector('[role="tab"][aria-selected="true"]');
				if (node === null) return null;
				const text = (node.textContent ?? "").trim();
				return text === "" ? null : text;
			} catch {
				return null;
			}
		}

		/** The key that identifies the page currently on screen. */
		function currentPageKey(panelId) {
			const panel = panelId ?? "conversation";
			if (panel !== "conversation") return panel;
			const tab = readActiveTabLabel();
			return tab === null ? "conversation" : `conversation/${tab}`;
		}

		/** A plain function, not a hook — so using it as a fallback adds no hook call. */
		const noPanelInfo = () => null;

		/**
		 * The page the clock last rendered on. The settings page reads it to offer
		 * "hide on this page", so the key is always something the user was looking at
		 * rather than something typed from memory.
		 */
		const pageKeyRef = { current: "conversation" };

		/**
		 * A clock that renders but cannot be read is this plugin's most-reported
		 * failure — "it disappeared". Nothing else in the system reports it: there is
		 * no exception, no missing node and no failed route, just a frame you cannot
		 * see. So it gets said out loud, once, with the exact keys responsible.
		 */
		let visibilityWarned = false;
		/** The page rule also returns null silently; say why, once. */
		let hiddenWarned = false;
		const NEON_PALETTES = ["ice", "green", "amber", "violet"];

		/** Perceptual lightness of a hex colour, so a near-white core can be detected. */
		function isLightColor(hex) {
			const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex ?? "");
			if (m === null) return false;
			const full = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
			const r = parseInt(full.slice(0, 2), 16);
			const g = parseInt(full.slice(2, 4), 16);
			const b = parseInt(full.slice(4, 6), 16);
			return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.55;
		}

		function warnIfUnreadable(cfg) {
			if (visibilityWarned || typeof console === "undefined" || typeof console.warn !== "function") return;
			const reasons = [];
			if (cfg.clockOpacity < 0.5) reasons.push(`clockOpacity=${cfg.clockOpacity}（出厂 1）`);
			if (cfg.segWidth < 3) reasons.push(`segWidth=${cfg.segWidth}（出厂 5.2）`);
			// A near-white core needs a dark backdrop. Against a light theme it is the
			// LIT segments that vanish while the unlit recesses stay visible, so the
			// display reads inside out.
			const scheme = themeSchemeReader();
			const neon = cfg.clockColor === "auto" ? scheme !== "light" : NEON_PALETTES.includes(cfg.clockColor);
			const lightCore = cfg.clockCore === "" ? neon : isLightColor(cfg.clockCore);
			if (scheme === "light" && lightCore) {
				reasons.push(`浅色主题 + 浅色数字（clockColor=${cfg.clockColor}${cfg.clockCore === "" ? "" : `, clockCore=${cfg.clockCore}`}）`);
			}
			if (reasons.length === 0) return;
			visibilityWarned = true;
			console.warn(
				`[桌面时钟] 时钟正在渲染，但按当前设置基本看不见：${reasons.join("；")}。\n` +
					"恢复：__dshDesktopClock.set({ clockOpacity: 1, segWidth: 5.2 })\n" +
					"浅色主题更推荐：__dshDesktopClock.set({ clockColor: 'auto' })（浅底自动改用墨色数字）"
			);
		}

		function ClockOverlay(props) {
			const cfg = useConfig();
			const now = useNow(cfg.clock);
			// `shell.overlay` occupants receive the layout hooks as props. The fallback
			// keeps the hook count stable if a host ever stops projecting it.
			const readPanel = props?.usePanelInfo ?? noPanelInfo;
			const panelId = readPanel((info) => info.activePanelId ?? null);
			// Portalled to <body>: an ancestor of `shell.overlay` that happens to
			// create a containing block would otherwise shift a `position:fixed` frame.
			const [host, setHost] = React.useState(null);
			const viewport = useViewport();
			const pointer = usePointer();
			const reducedMotion = usePrefersReducedMotion();
			const timeRef = React.useRef(null);
			const offsetsRef = React.useRef([]);
			const prevLitRef = React.useRef(null);

			React.useEffect(() => setHost(document.body), []);

			// Measured, not computed from the CSS: colon widths and gaps are layout,
			// and reading them back is the only way a flight can cross digits safely.
			React.useLayoutEffect(() => {
				const root = timeRef.current;
				if (root === null) {
					offsetsRef.current = [];
					return;
				}
				offsetsRef.current = Array.from(root.querySelectorAll(".dsh-dc-stage"), (el) => ({ x: el.offsetLeft, y: el.offsetTop }));
			});

			// The render plan and the lit set it implies, in one pass.
			const parts = [];
			const litList = [];
			const pushDigit = (ch) => {
				parts.push({ kind: "digit", value: ch, index: litList.length });
				litList.push(DIGIT_SEGMENTS[ch] ?? "");
			};
			const pushColon = (id) => parts.push({ kind: "colon", id });
			pushDigit(pad(now.getHours())[0]);
			pushDigit(pad(now.getHours())[1]);
			pushColon("c1");
			pushDigit(pad(now.getMinutes())[0]);
			pushDigit(pad(now.getMinutes())[1]);
			if (cfg.showSeconds) {
				pushColon("c2");
				pushDigit(pad(now.getSeconds())[0]);
				pushDigit(pad(now.getSeconds())[1]);
			}

			const second = Math.floor(now.getTime() / 1000);
			// Keyed on the second alone: a config change mid-second re-renders
			// without re-rolling the choreography.
			const tick = React.useMemo(
				() => computeTick(second, litList, prevLitRef.current, offsetsRef.current, config.current),
				[second]
			);
			React.useEffect(() => {
				prevLitRef.current = litList;
			});

			// Sample the layer situation once the wallpaper has had a chance to load,
			// then sample the clock four times — a flight lasts under half a second,
			// so one snapshot would usually miss it.
			React.useEffect(() => {
				const timers = [
					window.setTimeout(() => diag("layers", layerReport()), 1800),
					window.setTimeout(() => diag("escape", escapeReport()), 1900),
					window.setTimeout(() => diag("escape", escapeReport()), 2650),
					window.setTimeout(() => diag("escape", escapeReport()), 3400),
					window.setTimeout(() => diag("escape", escapeReport()), 4150)
				];
				return () => timers.forEach((id) => window.clearTimeout(id));
			}, []);

			// Re-read every render: the clock re-renders on the second and on every
			// pointer move, which is often enough to follow a tab switch without a
			// listener of its own.
			const pageKey = currentPageKey(panelId);
			pageKeyRef.current = pageKey;

			if (!cfg.clock || host === null) return null;
			if (cfg.hiddenPages.includes(pageKey)) {
				if (!hiddenWarned) {
					hiddenWarned = true;
					console.warn(`[桌面时钟] 时钟在这一页被「页面显示」规则隐藏了：${pageKey}。\n恢复：__dshDesktopClock.set({ hiddenPages: [] })`);
				}
				return null;
			}
			warnIfUnreadable(cfg);

			const palette = paletteFor(cfg, themeSchemeReader());
			const colonOn = !cfg.blink || now.getSeconds() % 2 === 0;

			const dateText = now.toLocaleDateString(undefined, {
				year: "numeric",
				month: "long",
				day: "numeric",
				weekday: "short"
			});

			// Fit to the viewport, then let clockScale nudge it. Scaling about the
			// centre keeps the flex centring valid without a second wrapper.
			const fit = cfg.autoScale
				? Math.min(
						(viewport.w * cfg.clockWidth) / CLOCK_W,
						(viewport.h * cfg.clockHeight) / clockHeight(cfg.showDate)
					)
				: 1;
			const scale = fit * cfg.clockScale;

			// Gyroscope: the pointer sets a tilt about the clock's own centre, plus a
			// small counter-drift so the face reads as floating rather than pinned.
			// The panel's own CSS transition does the damping — no spring needed.
			const gyroOn = cfg.gyro && !reducedMotion && cfg.gyroStrength > 0;
			const tiltX = gyroOn ? (0.5 - pointer.y) * 2 * cfg.gyroStrength : 0;
			const tiltY = gyroOn ? (pointer.x - 0.5) * 2 * cfg.gyroStrength : 0;
			const driftX = gyroOn ? (pointer.x - 0.5) * -2 * cfg.gyroShift : 0;
			const driftY = gyroOn ? (pointer.y - 0.5) * -2 * cfg.gyroShift : 0;

			// A plate is opt-in and OFF by default. It does fix the light-theme
			// inversion, but it is a black box in the middle of the conversation —
			// `clockColor: 'auto'` fixes the same inversion by switching palette, so
			// the plate stays a tool for people who specifically want a screen.
			const hasCard = cfg.clockPanel === true && cfg.clockPanelAlpha > 0.01;
			const alpha = cfg.clockPanelAlpha;
			const panelStyle = {
				transform: `perspective(1400px) translate3d(${driftX.toFixed(1)}px, ${driftY.toFixed(1)}px, 0) rotateX(${tiltX.toFixed(2)}deg) rotateY(${tiltY.toFixed(2)}deg) scale(${scale.toFixed(4)})`,
				opacity: cfg.clockOpacity
			};
			if (hasCard) {
				panelStyle.background = `rgba(8,12,16,${alpha})`;
				panelStyle.boxShadow = "0 0 0 1px rgba(140,220,255,.14), 0 18px 60px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.06)";
				if (cfg.clockBlur > 0) panelStyle.backdropFilter = `blur(${cfg.clockBlur}px)`;
			}
			const dateStyle = hasCard
				? { color: palette.glow1, opacity: 0.72 }
				: { color: palette.date, textShadow: "0 0 8px rgba(0,0,0,.9), 0 1px 3px rgba(0,0,0,.95)" };

			const glyphs = parts.map((part) =>
				part.kind === "colon"
					? h(Colon, { key: part.id, on: colonOn, palette, cfg })
					: h(Digit, { key: `d${part.index}`, value: part.value, digitIndex: part.index, palette, cfg, tick })
			);

			const layer = h(
				"div",
				{ className: "dsh-dc-layer", "data-pos": cfg.clockPosition },
				h(
					"div",
					{ className: `dsh-dc-panel${hasCard ? " has-card" : ""}`, style: panelStyle },
					h("div", { className: "dsh-dc-time", ref: timeRef }, ...glyphs),
					cfg.showDate ? h("div", { className: "dsh-dc-date", style: dateStyle }, dateText) : null
				)
			);

			return ReactDOM.createPortal(layer, host);
		}
		//#endregion

		//#region settings page
		function RangeField({ name, hint, value, min, max, step, display, onChange }) {
			return h(
				"div",
				{ className: "dsh-dc-field" },
				h("div", { className: "dsh-dc-head" }, h("span", { className: "dsh-dc-name" }, name), h("span", { className: "dsh-dc-val" }, display)),
				h("input", {
					type: "range",
					min,
					max,
					step,
					value,
					onChange: (event) => onChange(Number(event.target.value))
				}),
				hint ? h("div", { className: "dsh-dc-hint" }, hint) : null
			);
		}

		function CheckField({ name, value, onChange }) {
			return h(
				"label",
				{ className: "dsh-dc-check" },
				h("input", { type: "checkbox", checked: value, onChange: (event) => onChange(event.target.checked) }),
				h("span", null, name)
			);
		}

		/**
		 * A colour override. An empty value means "follow the palette", which a
		 * colour input cannot express on its own — so the swatch shows the colour
		 * that would be used, and a separate control returns to following.
		 */
		function ColorField({ name, hint, value, fallback, onChange }) {
			return h(
				"div",
				{ className: "dsh-dc-field" },
				h(
					"div",
					{ className: "dsh-dc-head" },
					h("span", { className: "dsh-dc-name" }, name),
					h("span", { className: "dsh-dc-val" }, value ? "自定义" : "跟随配色")
				),
				h(
					"div",
					{ className: "dsh-dc-row" },
					h("input", { type: "color", value: value || fallback, onChange: (event) => onChange(event.target.value) }),
					value
						? h("button", { type: "button", className: "dsh-dc-chip", onClick: () => onChange("") }, "恢复跟随配色 ×")
						: null
				),
				hint ? h("div", { className: "dsh-dc-hint" }, hint) : null
			);
		}

		function ChoiceField({ name, hint, value, options, onChange }) {
			return h(
				"div",
				{ className: "dsh-dc-field" },
				h("div", { className: "dsh-dc-head" }, h("span", { className: "dsh-dc-name" }, name)),
				h(
					"div",
					{ className: "dsh-dc-row" },
					options.map(([key, label]) =>
						h(
							"button",
							{
								key,
								type: "button",
								className: value === key ? "dsh-dc-chip dsh-dc-chip-on" : "dsh-dc-chip",
								onClick: () => onChange(key)
							},
							label
						)
					)
				),
				hint ? h("div", { className: "dsh-dc-hint" }, hint) : null
			);
		}

		/**
		 * The page a slider belongs on. Every control writes straight into the same
		 * config the clock reads, and `useConfig` re-renders this page from the same
		 * subscription — so a change made from the console shows up here too.
		 */
		function ClockSettings(props) {
			const cfg = useConfig();
			// Same live page key the clock uses. The settings page reads it for itself
			// rather than reusing the clock's last value: when the clock is hidden on
			// this very page, that value would be stale and the switch could never be
			// turned back on.
			const readPanel = props?.usePanelInfo ?? noPanelInfo;
			const panelId = readPanel((info) => info.activePanelId ?? null);
			const pageKey = currentPageKey(panelId);
			const hidden = cfg.hiddenPages;
			const isHidden = hidden.includes(pageKey);
			// The live palette, so an empty colour override can still show a swatch of
			// what will actually be used.
			const paletteBase = paletteFor(cfg, themeSchemeReader());
			const pct = (value) => `${Math.round(value * 100)}%`;
			const set = (patch) => writeConfig(patch);
			return h(
				"div",
				{ className: "dsh-dc-settings" },
				h("h3", null, "桌面时钟"),
				h("p", { className: "dsh-dc-sub" }, "壁纸背景与霓虹七段时钟。改动即时生效，存在浏览器 localStorage 里。"),
				h(RangeField, {
					name: "背景不透明度",
					hint: "越小，桌面壁纸越透出来；调到 0 就是壁纸原图。",
					value: cfg.canvasAlpha,
					min: 0,
					max: 1,
					step: 0.01,
					display: pct(cfg.canvasAlpha),
					onChange: (v) => set({ canvasAlpha: v })
				}),
				h(
					"div",
					{ className: "dsh-dc-field" },
					h(
						"div",
						{ className: "dsh-dc-head" },
						h("span", { className: "dsh-dc-name" }, "页面显示"),
						h("span", { className: "dsh-dc-val" }, isHidden ? `${pageKey} · 已隐藏` : pageKey)
					),
					h(
						"div",
						{ className: "dsh-dc-hint" },
						"时钟默认在所有页面显示。上面是当前页面的标识——这个标识是从界面上读出来的，不是我预先写死的名字，所以点到哪个页面就记哪个。"
					),
					h(
						"div",
						{ className: "dsh-dc-warn" },
						"注意：点下面的按钮，时钟会立刻从「你此刻在的这个页面」消失。它没有坏，只是被这条规则挡住了——把下面列表里的标签点掉就回来了。"
					),
					h(
						"button",
						{
							type: "button",
							className: "dsh-dc-reset",
							onClick: () =>
								set({
									hiddenPages: isHidden ? hidden.filter((key) => key !== pageKey) : [...hidden, pageKey]
								})
						},
						isHidden ? `在当前页面显示（${pageKey}）` : `在当前页面隐藏（${pageKey}）`
					),
					hidden.length > 0
						? h(
								"div",
								{ className: "dsh-dc-chips" },
								hidden.map((key) =>
									h(
										"button",
										{
											key,
											type: "button",
											className: "dsh-dc-chip",
											title: "点击取消隐藏",
											onClick: () => set({ hiddenPages: hidden.filter((other) => other !== key) })
										},
										`${key} ×`
									)
								),
								h(
									"button",
									{
										type: "button",
										className: "dsh-dc-chip",
										title: "清空列表，时钟回到所有页面显示",
										onClick: () => set({ hiddenPages: [] })
									},
									"全部恢复"
								)
							)
						: null
				),
				h(RangeField, {
					name: "背景模糊",
					hint: "把壁纸本身模糊掉。像素值，0 = 原图。",
					value: cfg.backgroundBlur,
					min: 0,
					max: 60,
					step: 1,
					display: `${cfg.backgroundBlur}px`,
					onChange: (v) => set({ backgroundBlur: v })
				}),
				h(RangeField, {
					name: "背景磨砂",
					hint: "磨砂不是第二种模糊：它在壁纸上叠一层细颗粒并压掉一点彩度，做出毛玻璃的「哑」感。",
					value: cfg.backgroundFrost,
					min: 0,
					max: 1,
					step: 0.01,
					display: pct(cfg.backgroundFrost),
					onChange: (v) => set({ backgroundFrost: v })
				}),
				h(RangeField, {
					name: "时钟不透明度",
					value: cfg.clockOpacity,
					min: 0,
					max: 1,
					step: 0.01,
					display: pct(cfg.clockOpacity),
					onChange: (v) => set({ clockOpacity: v })
				}),
				h(CheckField, { name: "液晶底板（暗底）", value: cfg.clockPanel, onChange: (v) => set({ clockPanel: v }) }),
				h(RangeField, {
					name: "底板不透明度",
					hint: "液晶靠明暗关系成立，必须有暗底。关掉它，浅色主题下会变成「亮线看不见、凹槽反而最刺眼」。",
					value: cfg.clockPanelAlpha,
					min: 0,
					max: 1,
					step: 0.01,
					display: pct(cfg.clockPanelAlpha),
					onChange: (v) => set({ clockPanelAlpha: v })
				}),
				h(RangeField, {
					name: "时钟大小",
					hint: "占视口宽度的比例。高度另有 60% 的上限，防止竖屏时溢出。",
					value: cfg.clockWidth,
					min: 0.15,
					max: 1.2,
					step: 0.01,
					display: pct(cfg.clockWidth),
					onChange: (v) => set({ clockWidth: v })
				}),
				h("div", { className: "dsh-dc-field" }, h("div", { className: "dsh-dc-head" }, h("span", { className: "dsh-dc-name" }, "外观"))),
				h(ColorField, {
					name: "数字颜色",
					hint: "亮着的线段本身的颜色。留空跟随所选配色。",
					value: cfg.clockCore,
					fallback: paletteBase.core,
					onChange: (v) => set({ clockCore: v })
				}),
				h(ColorField, {
					name: "光晕颜色",
					hint: "辉光会被展开成三层由内到外的光。留空则用配色自带的多色辉光（那种由白芯、青管、深蓝外晕组成的效果，一个颜色表达不出来）。",
					value: cfg.clockGlowColor,
					fallback: paletteBase.glow2,
					onChange: (v) => set({ clockGlowColor: v })
				}),
				h(RangeField, {
					name: "光晕强度",
					hint: "三层辉光半径的整体倍率。0 = 只剩细亮线。",
					value: cfg.clockGlow,
					min: 0,
					max: 2,
					step: 0.05,
					display: `${Math.round(cfg.clockGlow * 100)}%`,
					onChange: (v) => set({ clockGlow: v })
				}),
				h("div", { className: "dsh-dc-field" }, h("div", { className: "dsh-dc-head" }, h("span", { className: "dsh-dc-name" }, "形状"))),
				h(ChoiceField, {
					name: "每段切分",
					hint: "一条线段平均切成几截。切得越多，重组时的碎片越细。",
					value: String(cfg.segSplit),
					options: [
						["1", "1 截"],
						["2", "2 截"],
						["3", "3 截"],
						["4", "4 截"]
					],
					onChange: (v) => set({ segSplit: Number(v) })
				}),
				h(RangeField, {
					name: "切缝宽度",
					hint: "切分之间的缝（viewBox 单位）。小于笔画宽才读得成实心数字，太大就成虚线了。",
					value: cfg.segGap,
					min: 0,
					max: 8,
					step: 0.1,
					display: cfg.segGap.toFixed(1),
					onChange: (v) => set({ segGap: v })
				}),
				h(RangeField, {
					name: "笔画粗细",
					hint: "线段厚度（viewBox 单位）。",
					value: cfg.segWidth,
					min: 1.5,
					max: 12,
					step: 0.1,
					display: cfg.segWidth.toFixed(1),
					onChange: (v) => set({ segWidth: v })
				}),
				h(RangeField, {
					name: "端点圆角",
					hint: "1 = 全圆头，0 = 方头。",
					value: cfg.endRound,
					min: 0,
					max: 1,
					step: 0.05,
					display: `${Math.round(cfg.endRound * 100)}%`,
					onChange: (v) => set({ endRound: v })
				}),
				h("div", { className: "dsh-dc-field" }, h("div", { className: "dsh-dc-head" }, h("span", { className: "dsh-dc-name" }, "动效"))),
				h(ChoiceField, {
					name: "切换动画",
					hint: "时间变化时数字怎么换。flow = 线段飞向新位置；burst = 炸成粒子再重新聚合成新数字。",
					value: cfg.animation,
					options: [
						["flow", "线段飞行"],
						["burst", "粒子爆炸重组"]
					],
					onChange: (v) => set({ animation: v })
				}),
				cfg.animation === "burst"
					? h(RangeField, {
							name: "粒子数量",
							hint: "每块线段炸出的粒子数。线路段越多越密，但 DOM 也越多。",
							value: cfg.burstCount,
							min: 1,
							max: 10,
							step: 1,
							display: `${cfg.burstCount} 粒`,
							onChange: (v) => set({ burstCount: v })
						})
					: null,
				cfg.animation === "burst"
					? h(RangeField, {
							name: "飞散距离",
							hint: "粒子向外飞散的距离（像素）。",
							value: cfg.burstSpread,
							min: 10,
							max: 300,
							step: 5,
							display: `${Math.round(cfg.burstSpread)}px`,
							onChange: (v) => set({ burstSpread: v })
						})
					: null,
				h(CheckField, { name: "跟随鼠标倾斜（陀螺仪）", value: cfg.gyro, onChange: (v) => set({ gyro: v }) }),
				h(RangeField, {
					name: "倾斜强度",
					value: cfg.gyroStrength,
					min: 0,
					max: 24,
					step: 0.5,
					display: `${cfg.gyroStrength}°`,
					onChange: (v) => set({ gyroStrength: v })
				}),
				h(CheckField, { name: "每秒拆解重组（线段飞行）", value: cfg.morph, onChange: (v) => set({ morph: v }) }),
				h(RangeField, {
					name: "景深后退距离",
					hint: "没点亮的线段向屏幕里退多远。0 = 压平成纯平面。",
					value: cfg.depth,
					min: 0,
					max: 400,
					step: 5,
					display: `${cfg.depth}px`,
					onChange: (v) => set({ depth: v })
				}),
				h("button", { className: "dsh-dc-reset", type: "button", onClick: () => set({ ...DEFAULT_CONFIG }) }, "全部恢复默认")
			);
		}
		//#endregion

		//#region lifecycle
		function applyBackgroundVisibility() {
			const shown = config.current.background;
			if (backgroundEl !== null) backgroundEl.style.display = shown ? "" : "none";
			if (frostEl !== null) frostEl.style.display = shown && config.current.backgroundFrost > 0.001 ? "" : "none";
		}

		function apply(ctx) {
			themeSchemeReader = () => {
				try {
					return ctx.theme.getTheme()?.active?.colorScheme ?? "dark";
				} catch {
					return "dark";
				}
			};
			ensureStyle();
			applyShellTransparency(ctx);
			// The effective config, not the defaults: a stored value outranks a
			// default, and this line is how that becomes visible instead of guessed.
			diag("apply", `v${CONFIG_VERSION} ${JSON.stringify(config.current)}`);

			if (config.current.background) {
				ensureBackgroundElement();
				refreshWallpaper();
				pollTimer = window.setInterval(refreshWallpaper, WALLPAPER_POLL_MS);
			}

			// React to `window.__dshDesktopClock.set(...)` and the settings sliders
			// without a reload. Guarded on the three keys this listener actually
			// consumes: dragging the opacity slider fires a change per pointer event,
			// and an unguarded listener would turn that into a fetch storm at /info.
			let applied = { canvasAlpha: NaN, transparentShell: null, background: null, backgroundBlur: NaN, backgroundFrost: NaN };
			ctx.effect(() => {
				const listener = () => {
					const current = config.current;
					if (
						current.canvasAlpha === applied.canvasAlpha &&
						current.transparentShell === applied.transparentShell &&
						current.background === applied.background &&
						current.backgroundBlur === applied.backgroundBlur &&
						current.backgroundFrost === applied.backgroundFrost
					) {
						return;
					}
					applied = {
						canvasAlpha: current.canvasAlpha,
						transparentShell: current.transparentShell,
						background: current.background,
						backgroundBlur: current.backgroundBlur,
						backgroundFrost: current.backgroundFrost
					};
					applyShellTransparency(ctx);
					applyBackgroundVisibility();
					if (current.background) ensureBackgroundElement();
					applyBackgroundEffects();
				};
				configListeners.add(listener);
				return () => configListeners.delete(listener);
			}, "dsh-desktop-clock: config application");

			ctx.effect(
				() =>
					ctx.slots.inject("shell.overlay", () =>
						ctx.slots.register({ name: "shell.overlay", id: "dsh-desktop-clock", order: 1000 }, ClockOverlay)
					),
				"dsh-desktop-clock: clock overlay"
			);

			ctx.effect(
				() =>
					ctx.slots.inject("settings.section", () =>
						ctx.slots.register(
							{ name: "settings.section", id: "desktop-clock", order: 60, label: () => "桌面时钟" },
							ClockSettings
						)
					),
				"dsh-desktop-clock: settings section"
			);

			ctx.effect(
				() => () => {
					if (pollTimer !== null) window.clearInterval(pollTimer);
					pollTimer = null;
					backgroundEl?.remove();
					backgroundEl = null;
					frostEl?.remove();
					frostEl = null;
					overrideDispose?.();
					overrideDispose = null;
					document.getElementById(STYLE_ID)?.remove();
				},
				"dsh-desktop-clock: teardown"
			);

			window.__dshDesktopClock = {
				get config() {
					return { ...config.current };
				},
				set(patch) {
					writeConfig(patch);
					return { ...config.current };
				},
				reset() {
					writeConfig({ ...DEFAULT_CONFIG });
					return { ...config.current };
				},
				palettes: { ...PALETTES },
				layerReport,
				escapeReport,
				/** The page key the clock is currently rendering on, for the console. */
				page: () => pageKeyRef.current,
				refreshWallpaper
			};
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
