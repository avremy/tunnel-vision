import streamDeck, {
	action,
	DidReceiveSettingsEvent,
	JsonObject,
	JsonValue,
	KeyAction,
	KeyDownEvent,
	PropertyInspectorDidAppearEvent,
	SendToPluginEvent,
	SingletonAction,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";
import { randomUUID } from "node:crypto";
import { platform, ProfileSpec, SetupStep } from "../platform";
import { renderKey } from "../render";
import { DisconnectMode, VpnSession } from "../vpn-session";

type Settings = JsonObject & {
	profileId?: string;
	name?: string;
	host?: string;
	port?: string;
	username?: string;
	trustedCert?: string;
	scriptPath?: string;
	disconnectMode?: DisconnectMode;
};

type Key = { action: KeyAction<Settings>; settings: Settings };

const POLL_MS = 4_000;

const specFrom = (s: Settings): ProfileSpec => ({
	id: s.profileId ?? "unconfigured",
	host: s.host,
	port: s.port,
	username: s.username,
	trustedCert: s.trustedCert,
	scriptPath: s.scriptPath,
});
const FRAME_MS = 450;

@action({ UUID: "com.avremy.openfortigate.vpn" })
export class VpnToggle extends SingletonAction<Settings> {
	private readonly keys = new Map<string, Key>();
	private readonly sessions = new Map<string, VpnSession>();
	private readonly lastImage = new Map<string, string>();
	/** profileId → are all setup steps done? Unfinished setup shows SETUP on the key. */
	private readonly setupOk = new Map<string, boolean>();
	private setupRunning?: string;
	private pollTimer?: NodeJS.Timeout;
	private frameTimer?: NodeJS.Timeout;
	private frame = 0;

	// ---------- lifecycle ----------

	override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
		if (!ev.action.isKey()) return;
		const settings = { ...ev.payload.settings };
		if (!settings.profileId) {
			settings.profileId = randomUUID();
			await ev.action.setSettings(settings);
		}
		this.keys.set(ev.action.id, { action: ev.action, settings });
		this.session(settings).setTarget(specFrom(settings));
		this.ensureTimers();
		void this.session(settings).poll();
		this.render(ev.action.id);
		void this.refreshSetup(settings);
	}

	override onWillDisappear(ev: WillDisappearEvent<Settings>): void {
		this.keys.delete(ev.action.id);
		this.lastImage.delete(ev.action.id);
		if (this.keys.size === 0) {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
		}
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): void {
		const key = this.keys.get(ev.action.id);
		if (!key) return;
		const incoming = { ...ev.payload.settings };
		if (!incoming.profileId && key.settings.profileId) {
			incoming.profileId = key.settings.profileId;
			void ev.action.setSettings(incoming);
		}
		key.settings = incoming;
		const s = this.session(key.settings);
		if (s.status === "disconnected" || s.status === "error") s.setTarget(specFrom(key.settings));
		this.render(ev.action.id);
		void this.sendState(key.settings);
		void this.refreshSetup(key.settings);
	}

	override async onPropertyInspectorDidAppear(ev: PropertyInspectorDidAppearEvent<Settings>): Promise<void> {
		const key = this.keys.get(ev.action.id);
		if (!key) return;
		await this.sendState(key.settings);
		await this.refreshSetup(key.settings);
	}

	// ---------- key press ----------

	override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
		const key = this.keys.get(ev.action.id);
		const settings = key?.settings ?? ev.payload.settings;
		await this.toggle(ev.action as KeyAction<Settings>, settings);
	}

	private async toggle(act: KeyAction<Settings>, settings: Settings): Promise<void> {
		const s = this.session(settings);

		if (s.status === "connected" || s.status === "connecting") {
			await s.disconnect(settings.disconnectMode ?? "profile");
			return;
		}
		if (s.status === "disconnecting") return;

		if (!settings.host || !settings.username) {
			s.lastError = "Set gateway and username in the button settings";
			await act.showAlert();
			void this.sendState(settings);
			return;
		}
		if (!(await platform.hasPassword(settings.profileId!))) {
			s.lastError = "No password saved — enter it in the button settings";
			await act.showAlert();
			void this.sendState(settings);
			return;
		}
		streamDeck.logger.info(`Connecting ${this.label(settings)} → ${settings.host}:${settings.port || 443}`);
		void s.connect(specFrom(settings));
	}

	// ---------- property inspector messages ----------

	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, Settings>): Promise<void> {
		const key = this.keys.get(ev.action.id);
		if (!key) return;
		const msg = (ev.payload ?? {}) as { type?: string; password?: string };
		const id = key.settings.profileId!;
		const s = this.session(key.settings);

		try {
			switch (msg.type) {
				case "savePassword":
					if (msg.password) {
						await platform.setPassword(id, msg.password, `Tunnel Vision – ${this.label(key.settings)}`);
						if (s.lastError?.startsWith("No password")) s.lastError = undefined;
					}
					break;
				case "forgetPassword":
					await platform.deletePassword(id);
					break;
				case "toggle":
					if (key.action.isKey()) await this.toggle(key.action, key.settings);
					break;
				case "clearError":
					s.lastError = undefined;
					break;
				case "setupCheck":
					break;
				case "setupRun": {
					const step = String((ev.payload as { step?: unknown }).step ?? "");
					if (this.setupRunning) break;
					this.setupRunning = step;
					await this.refreshSetup(key.settings, { skipCheck: true });
					let message: string | undefined;
					let error: string | undefined;
					try {
						message = await platform.runSetup(step, specFrom(key.settings));
					} catch (e) {
						error = (e as Error).message;
					} finally {
						this.setupRunning = undefined;
					}
					await this.refreshSetup(key.settings, { message, error });
					return;
				}
			}
		} catch (e) {
			s.lastError = (e as Error).message;
		}
		this.render(ev.action.id);
		await this.sendState(key.settings);
		if (msg.type !== "toggle" && msg.type !== "clearError") await this.refreshSetup(key.settings);
	}

	// ---------- setup checklist ----------

	private lastSteps = new Map<string, SetupStep[]>();

	private async refreshSetup(
		settings: Settings,
		opts: { message?: string; error?: string; skipCheck?: boolean } = {},
	): Promise<void> {
		const id = settings.profileId;
		if (!id) return;
		let steps = this.lastSteps.get(id) ?? [];
		if (!opts.skipCheck) {
			try {
				steps = await platform.checkSetup(specFrom(settings));
			} catch (e) {
				steps = [{ id: "check", title: "Check setup", ok: false, detail: `Couldn't check: ${(e as Error).message}` }];
			}
			const hasPw = await platform.hasPassword(id);
			const missing = [!settings.host && "gateway", !settings.username && "username", !hasPw && "password"].filter(Boolean);
			steps.push({
				id: "details",
				title: "Add your VPN details",
				ok: missing.length === 0,
				detail: missing.length ? `Fill in the ${missing.join(", ")} below.` : "Gateway, username and password are set.",
			});
			this.lastSteps.set(id, steps);
		}
		const ok = steps.every((st) => st.ok);
		if (this.setupOk.get(id) !== ok) {
			this.setupOk.set(id, ok);
			this.renderProfile(id);
		}
		const pi = streamDeck.ui.current;
		if (!pi) return;
		const piKey = this.keys.get(pi.action.id);
		if (!piKey || piKey.settings.profileId !== id) return;
		await pi.sendToPropertyInspector({
			type: "setup",
			profileId: id,
			platform: platform.name,
			steps: steps as unknown as JsonValue,
			running: this.setupRunning ?? null,
			message: opts.message ?? null,
			error: opts.error ?? null,
		});
	}

	// ---------- helpers ----------

	private label(settings: Settings): string {
		return settings.name?.trim() || settings.host?.trim() || "VPN";
	}

	private session(settings: Settings): VpnSession {
		const id = settings.profileId ?? "unconfigured";
		let s = this.sessions.get(id);
		if (!s) {
			s = new VpnSession(id);
			s.setTarget(specFrom(settings));
			s.on("change", () => {
				this.ensureTimers();
				this.renderProfile(id);
				void this.sendStateFor(id);
			});
			s.on("log", () => void this.sendStateFor(id));
			s.on("alert", () => {
				for (const k of this.keys.values()) if (k.settings.profileId === id) void k.action.showAlert();
			});
			this.sessions.set(id, s);
		}
		return s;
	}

	private ensureTimers(): void {
		if (!this.pollTimer && this.keys.size) {
			this.pollTimer = setInterval(() => {
				const seen = new Set<string>();
				for (const k of this.keys.values()) {
					const id = k.settings.profileId;
					if (!id || seen.has(id)) continue;
					seen.add(id);
					void this.session(k.settings).poll();
				}
				for (const id of this.keys.keys()) this.render(id); // keeps the uptime fresh
			}, POLL_MS);
		}
		const busy = [...this.sessions.values()].some((s) => s.status === "connecting" || s.status === "disconnecting");
		if (busy && !this.frameTimer) {
			this.frameTimer = setInterval(() => {
				this.frame++;
				const stillBusy = [...this.sessions.values()].some((s) => s.status === "connecting" || s.status === "disconnecting");
				if (!stillBusy) {
					clearInterval(this.frameTimer);
					this.frameTimer = undefined;
				}
				for (const id of this.keys.keys()) this.render(id);
			}, FRAME_MS);
		}
	}

	private renderProfile(profileId: string): void {
		for (const [ctx, k] of this.keys) if (k.settings.profileId === profileId) this.render(ctx);
	}

	private render(ctx: string): void {
		const k = this.keys.get(ctx);
		if (!k) return;
		const configured = !!(k.settings.host && k.settings.username);
		const s = this.session(k.settings);
		const needsSetup = !configured || this.setupOk.get(k.settings.profileId ?? "") === false;
		const status = needsSetup && s.status === "disconnected" ? "setup" : s.status;
		const img = renderKey({ name: this.label(k.settings), status, frame: this.frame, connectedSince: s.connectedSince });
		if (this.lastImage.get(ctx) === img) return;
		this.lastImage.set(ctx, img);
		void k.action.setImage(img);
	}

	private async sendStateFor(profileId: string): Promise<void> {
		for (const k of this.keys.values()) if (k.settings.profileId === profileId) return this.sendState(k.settings);
	}

	private async sendState(settings: Settings): Promise<void> {
		const pi = streamDeck.ui.current;
		if (!pi || !settings.profileId) return;
		const piKey = this.keys.get(pi.action.id);
		if (!piKey || piKey.settings.profileId !== settings.profileId) return; // another key's / action's panel
		const s = this.session(settings);
		await pi.sendToPropertyInspector({
			type: "state",
			profileId: settings.profileId,
			status: s.status,
			connectedSince: s.connectedSince ?? null,
			lastError: s.lastError ?? null,
			suggestedCert: s.suggestedCert ?? null,
			hasPassword: await platform.hasPassword(settings.profileId),
			defaultScript: platform.defaultScript ?? null,
			platform: platform.name,
			passwordStore: platform.passwordStoreLabel,
			log: s.log.slice(-40),
		});
	}
}
