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
import * as nc from "../native/scutil";
import { renderKey } from "../render";
import type { VpnStatus } from "../vpn-session";

type Settings = JsonObject & { serviceId?: string; serviceName?: string };
type Key = { action: KeyAction<Settings>; settings: Settings };
type Pending = { want: "on" | "off"; since: number; sawConnecting: boolean };

const IS_MAC = process.platform === "darwin";
const POLL_MS = 2_500;
const FRAME_MS = 450;
const START_TIMEOUT_MS = 45_000;
const FAIL_HINT = "Couldn't connect. Open System Settings → VPN to check it — it may need a saved password or the VPN app to be running.";

/** Toggle a VPN from System Settings → VPN (macOS only). The key shows ENABLED / DISABLED. */
@action({ UUID: "com.avremy.openfortigate.nativevpn" })
export class NativeVpnToggle extends SingletonAction<Settings> {
	private readonly keys = new Map<string, Key>();
	private services = new Map<string, nc.NcService>();
	private listError?: string;
	private readonly pending = new Map<string, Pending>();
	private readonly errors = new Map<string, string>();
	private readonly lastImage = new Map<string, string>();
	/** Stream Deck state per key: 1 = enabled (connected), 0 = anything else. */
	private readonly lastState = new Map<string, number>();
	private pollTimer?: NodeJS.Timeout;
	private frameTimer?: NodeJS.Timeout;
	private frame = 0;
	private refreshing?: Promise<void>;

	// ---------- lifecycle ----------

	override onWillAppear(ev: WillAppearEvent<Settings>): void {
		if (!ev.action.isKey()) return;
		this.keys.set(ev.action.id, { action: ev.action, settings: { ...ev.payload.settings } });
		this.ensurePoll();
		this.render(ev.action.id);
		void this.refresh();
	}

	override onWillDisappear(ev: WillDisappearEvent<Settings>): void {
		this.keys.delete(ev.action.id);
		this.lastImage.delete(ev.action.id);
		this.lastState.delete(ev.action.id);
		if (this.keys.size === 0) {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
		}
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): void {
		const key = this.keys.get(ev.action.id);
		if (!key) return;
		key.settings = { ...ev.payload.settings };
		this.render(ev.action.id);
		void this.sendState();
	}

	override async onPropertyInspectorDidAppear(_ev: PropertyInspectorDidAppearEvent<Settings>): Promise<void> {
		await this.refresh();
	}

	override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
		const key = this.keys.get(ev.action.id);
		if (key) await this.toggle(key);
	}

	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, Settings>): Promise<void> {
		const key = this.keys.get(ev.action.id);
		const msg = (ev.payload ?? {}) as { type?: string };
		if (msg.type === "toggle" && key) await this.toggle(key);
		else await this.refresh();
	}

	// ---------- toggling ----------

	private async toggle(key: Key): Promise<void> {
		const id = key.settings.serviceId;
		if (!IS_MAC || !id) {
			await key.action.showAlert();
			return;
		}
		if (!this.services.has(id)) await this.refresh();
		const svc = this.services.get(id);
		if (!svc) {
			await key.action.showAlert();
			return;
		}
		const on = svc.status === "Connected" || svc.status === "Connecting" || this.pending.get(id)?.want === "on";
		this.errors.delete(id);
		this.pending.set(id, { want: on ? "off" : "on", since: Date.now(), sawConnecting: false });
		this.renderService(id);
		this.ensureFrames();
		try {
			if (on) await nc.stop(id);
			else await nc.start(id);
			streamDeck.logger.info(`${on ? "Stopping" : "Starting"} native VPN "${svc.name}"`);
		} catch (e) {
			this.pending.delete(id);
			this.errors.set(id, (e as Error).message);
			await key.action.showAlert();
		}
		await this.refresh();
	}

	// ---------- polling ----------

	private ensurePoll(): void {
		if (!this.pollTimer && IS_MAC) this.pollTimer = setInterval(() => void this.refresh(), POLL_MS);
	}

	private ensureFrames(): void {
		if (this.frameTimer) return;
		this.frameTimer = setInterval(() => {
			this.frame++;
			let busy = false;
			for (const ctx of this.keys.keys()) {
				const v = this.view(this.keys.get(ctx)!.settings);
				if (v.status === "connecting" || v.status === "disconnecting") busy = true;
				this.render(ctx);
			}
			if (!busy) {
				clearInterval(this.frameTimer);
				this.frameTimer = undefined;
			}
		}, FRAME_MS);
	}

	private refresh(): Promise<void> {
		if (!IS_MAC) {
			this.renderAll();
			return this.sendState();
		}
		// Coalesce overlapping refreshes (timer + PI + key press).
		this.refreshing ??= this.doRefresh().finally(() => (this.refreshing = undefined));
		return this.refreshing;
	}

	private async doRefresh(): Promise<void> {
		try {
			const list = await nc.listServices();
			this.services = new Map(list.map((s) => [s.id, s]));
			this.listError = undefined;
		} catch (e) {
			this.listError = (e as Error).message;
		}

		const now = Date.now();
		for (const [id, p] of this.pending) {
			const st = this.services.get(id)?.status;
			if (p.want === "on") {
				if (st === "Connected") this.pending.delete(id);
				else if (st === "Connecting") p.sawConnecting = true;
				else if ((st === "Disconnected" && (p.sawConnecting || now - p.since > 8_000)) || now - p.since > START_TIMEOUT_MS) {
					this.pending.delete(id);
					this.errors.set(id, FAIL_HINT);
					this.alertService(id);
				}
			} else if (st !== "Connected" && st !== "Disconnecting") {
				this.pending.delete(id);
			} else if (now - p.since > START_TIMEOUT_MS) {
				this.pending.delete(id);
				this.errors.set(id, "The VPN didn't disconnect.");
				this.alertService(id);
			}
		}
		this.renderAll();
		if ([...this.keys.values()].some((k) => ["connecting", "disconnecting"].includes(this.view(k.settings).status))) this.ensureFrames();
		await this.sendState();
	}

	// ---------- rendering ----------

	private view(s: Settings): { status: VpnStatus | "setup"; label: string } {
		if (!IS_MAC) return { status: "error", label: "MAC ONLY" };
		if (!s.serviceId) return { status: "setup", label: "SETUP" };
		const svc = this.services.get(s.serviceId);
		if (!svc) return this.listError ? { status: "error", label: "ERROR" } : { status: "error", label: "NOT FOUND" };
		const p = this.pending.get(s.serviceId);
		if (p?.want === "on" && svc.status !== "Connected") return { status: "connecting", label: "CONNECTING" };
		if (p?.want === "off" && svc.status !== "Disconnected") return { status: "disconnecting", label: "STOPPING" };
		switch (svc.status) {
			case "Connected":
				return { status: "connected", label: "ENABLED" };
			case "Connecting":
				return { status: "connecting", label: "CONNECTING" };
			case "Disconnecting":
				return { status: "disconnecting", label: "STOPPING" };
			case "Disconnected":
				return this.errors.has(svc.id) ? { status: "error", label: "FAILED" } : { status: "disconnected", label: "DISABLED" };
			default:
				return { status: "error", label: svc.status.toUpperCase().slice(0, 10) };
		}
	}

	private render(ctx: string): void {
		const k = this.keys.get(ctx);
		if (!k) return;
		const v = this.view(k.settings);
		const name = k.settings.serviceName || this.services.get(k.settings.serviceId ?? "")?.name || "VPN";
		const state = v.status === "connected" ? 1 : 0;
		if (this.lastState.get(ctx) !== state) {
			this.lastState.set(ctx, state);
			void k.action.setState(state);
		}
		const img = renderKey({ name, status: v.status, label: v.label, frame: this.frame });
		if (this.lastImage.get(ctx) === img) return;
		this.lastImage.set(ctx, img);
		void k.action.setImage(img);
	}

	private renderAll(): void {
		for (const ctx of this.keys.keys()) this.render(ctx);
	}

	private renderService(id: string): void {
		for (const [ctx, k] of this.keys) if (k.settings.serviceId === id) this.render(ctx);
	}

	private alertService(id: string): void {
		for (const k of this.keys.values()) if (k.settings.serviceId === id) void k.action.showAlert();
	}

	// ---------- property inspector ----------

	private async sendState(): Promise<void> {
		const pi = streamDeck.ui.current;
		if (!pi) return;
		const key = this.keys.get(pi.action.id);
		if (!key) return; // the open panel belongs to another action
		const id = key.settings.serviceId;
		const v = this.view(key.settings);
		await pi.sendToPropertyInspector({
			type: "native",
			mac: IS_MAC,
			services: [...this.services.values()].map((s) => ({ id: s.id, name: s.name, kind: s.kind, status: s.status })),
			serviceId: id ?? null,
			status: v.status,
			label: v.label,
			error: (id && this.errors.get(id)) || this.listError || null,
		});
	}
}
