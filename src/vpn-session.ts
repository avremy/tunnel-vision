import { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { DisconnectMode, platform, ProfileSpec } from "./platform";

export type VpnStatus = "disconnected" | "connecting" | "connected" | "disconnecting" | "error";
export type { DisconnectMode };

const CONNECT_TIMEOUT_MS = 60_000;
const MAX_LOG_LINES = 80;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One VPN profile, OS-agnostic. The platform layer starts/stops the tunnel and makes sure its output
 * lands in this profile's log file; we tail that file to learn the state.
 *  - macOS: we own the child (bash → sudo openfortivpn) and see it exit.
 *  - Windows: an elevated helper owns openconnect and appends "[TunnelVision] … exited" when it ends.
 */
export class VpnSession extends EventEmitter {
	status: VpnStatus = "disconnected";
	connectedSince?: number;
	lastError?: string;
	suggestedCert?: string;
	log: string[] = [];
	spec: ProfileSpec;

	private child?: ChildProcess;
	private readonly logFile: string;
	private readOffset = 0;
	private partial = "";
	private tailTimer?: NodeJS.Timeout;
	private connectTimer?: NodeJS.Timeout;
	private failAfterStop = false;
	private pendingExit = false;
	/** openconnect prints "certificate verify failed" even when the pinned cert then matches. */
	private certFailed = false;

	constructor(readonly id: string) {
		super();
		this.spec = { id };
		fs.mkdirSync(platform.logDir, { recursive: true });
		this.logFile = path.join(platform.logDir, `${id.replace(/[^\w.-]/g, "_")}.log`);
	}

	setTarget(spec: ProfileSpec): void {
		this.spec = {
			...spec,
			id: this.id,
			host: spec.host?.trim() || undefined,
			port: spec.port?.trim() || "443",
			username: spec.username?.trim() || undefined,
			trustedCert: spec.trustedCert?.trim() || undefined,
		};
	}

	private set(status: VpnStatus): void {
		if (status === "connected" && this.status !== "connected") this.connectedSince = Date.now();
		if (status !== "connected") this.connectedSince = undefined;
		if (status === this.status) return;
		this.status = status;
		this.emit("change");
	}

	async connect(spec: ProfileSpec): Promise<void> {
		if (this.status === "connecting" || this.status === "connected" || this.status === "disconnecting") return;
		this.setTarget(spec);
		this.lastError = undefined;
		this.suggestedCert = undefined;
		this.failAfterStop = false;
		this.pendingExit = false;
		this.certFailed = false;
		this.log = [];
		this.partial = "";
		fs.writeFileSync(this.logFile, "");
		this.readOffset = 0;
		this.set("connecting");
		this.startTail();

		let child: ChildProcess | undefined;
		try {
			child = await platform.launch(this.spec, this.logFile);
		} catch (e) {
			this.stopTail();
			this.lastError = (e as Error).message;
			this.set("error");
			this.emit("alert");
			this.emit("change");
			return;
		}

		if (child) {
			this.child = child;
			child.on("error", (e) => {
				this.lastError = e.message;
				this.set("error");
			});
			child.on("exit", (code) => {
				if (this.child === child) this.child = undefined;
				this.readNew();
				this.stopTail();
				clearTimeout(this.connectTimer);
				if (this.failAfterStop) {
					this.set("error");
				} else if (this.status === "connecting") {
					this.lastError ??= `VPN client exited (code ${code ?? "?"})`;
					this.set("error");
				} else if (this.status !== "error") {
					this.set("disconnected");
				}
				this.emit("change");
			});
		}

		this.connectTimer = setTimeout(() => {
			if (this.status !== "connecting") return;
			this.lastError ??= "Timed out waiting for the tunnel to come up";
			this.failAfterStop = true;
			void this.disconnect("profile");
		}, CONNECT_TIMEOUT_MS);
	}

	async disconnect(mode: DisconnectMode): Promise<void> {
		const before = this.status;
		this.set("disconnecting");
		const res = await platform.stop(this.spec, mode);
		// Windows logs out of the gateway before exiting, which can take a few seconds.
		for (let i = 0; i < 30 && (await this.isRunning()); i++) await delay(500);

		if (await this.isRunning()) {
			this.lastError = platform.stopFailureHint(res.out) ?? `Could not stop the tunnel: ${res.out.trim() || `exit ${res.code}`}`;
			this.set(before === "connecting" ? "error" : "connected");
			this.emit("alert");
			this.emit("change");
			return;
		}
		if (!this.child) {
			this.readNew();
			this.stopTail();
			clearTimeout(this.connectTimer);
			this.set(this.failAfterStop ? "error" : "disconnected");
			this.emit("change");
		}
		// otherwise the child's exit handler finalises the state
	}

	isRunning(): Promise<boolean> {
		return platform.isRunning(this.spec);
	}

	/** Reconcile with reality (tunnels started elsewhere, before a restart, or dropped on their own). */
	async poll(): Promise<void> {
		if (this.status === "connecting" || this.status === "disconnecting") return;
		const running = await this.isRunning();
		if (running && (this.status === "disconnected" || this.status === "error") && !this.child) {
			this.lastError = undefined;
			this.set("connected");
			if (this.log.length === 0 && fs.existsSync(this.logFile)) this.readNew();
		} else if (!running && this.status === "connected" && !this.child) {
			this.set("disconnected");
		}
	}

	/** Windows: the helper reported that openconnect ended. */
	private finishExternal(): void {
		clearTimeout(this.connectTimer);
		this.stopTail();
		if (this.failAfterStop) {
			this.set("error");
		} else if (this.status === "connecting") {
			if (this.certFailed) this.lastError = "The gateway's certificate isn't trusted — click “Trust this certificate”";
			else this.lastError ??= "VPN client exited before the tunnel came up";
			this.set("error");
		} else if (this.status === "connected") {
			this.set("disconnected");
		}
		this.emit("change");
	}

	private startTail(): void {
		this.stopTail();
		this.tailTimer = setInterval(() => this.readNew(), 400);
	}

	private stopTail(): void {
		if (this.tailTimer) clearInterval(this.tailTimer);
		this.tailTimer = undefined;
	}

	private readNew(): void {
		let buf: Buffer;
		try {
			const size = fs.statSync(this.logFile).size;
			if (size < this.readOffset) this.readOffset = 0;
			if (size === this.readOffset) return;
			const fd = fs.openSync(this.logFile, "r");
			buf = Buffer.alloc(size - this.readOffset);
			fs.readSync(fd, buf, 0, buf.length, this.readOffset);
			fs.closeSync(fd);
			this.readOffset = size;
		} catch {
			return;
		}
		const text = this.partial + buf.toString("utf8");
		const lines = text.split(/\r?\n/);
		this.partial = lines.pop() ?? "";
		let changed = false;
		for (const raw of lines) {
			const line = raw.replace(/^﻿/, "");
			if (!line.trim()) continue;
			this.log.push(line);
			changed = true;
			this.parse(line);
		}
		if (this.log.length > MAX_LOG_LINES) this.log.splice(0, this.log.length - MAX_LOG_LINES);
		if (changed) this.emit("log");
		if (this.pendingExit) {
			this.pendingExit = false;
			this.finishExternal();
		}
	}

	private parse(line: string): void {
		// openfortivpn: "Tunnel is up and running". openconnect (fortinet/PPP): "Configured as 10.x.x.x, with SSL…".
		if (/Tunnel is up and running/i.test(line) || /^(Configured as|Connected as) /.test(line)) {
			clearTimeout(this.connectTimer);
			this.lastError = undefined;
			this.set("connected");
			return;
		}
		const tvErr = line.match(/^\[TunnelVision\] ERROR:\s*(.+)$/);
		if (tvErr) {
			this.lastError = tvErr[1].trim();
			return;
		}
		if (/^\[TunnelVision\] .*exited/.test(line)) {
			if (!this.child) this.pendingExit = true;
			return;
		}
		const hint = platform.lineHint(line);
		if (hint) {
			this.lastError = hint;
			return;
		}
		const ofCert = line.match(/--trusted-cert[ =]?([0-9a-f]{64})/i);
		if (ofCert) this.suggestedCert = ofCert[1].toLowerCase();
		const ocCert = line.match(/--servercert[ =]?(pin-sha256:[A-Za-z0-9+/]{43}=|sha256:[0-9a-f]{64})/i);
		if (ocCert) this.suggestedCert = ocCert[1];

		const err = line.match(/^ERROR:\s*(.+)$/);
		if (err && !this.lastError) {
			this.lastError = err[1].trim();
			return;
		}
		if (platform.name !== "windows" || this.status !== "connecting") return;

		// openconnect: a pinned cert still logs "verify failed" before it's accepted, so only count it
		// if the TLS connection doesn't go on to succeed.
		if (/certificate verify failed/i.test(line)) {
			this.certFailed = true;
			return;
		}
		if (/^Connected to HTTPS on /.test(line)) {
			this.certFailed = false;
			return;
		}
		if (/Failed to establish PPP/i.test(line)) {
			this.lastError =
				"Login worked but the gateway dropped the tunnel (Failed to establish PPP). Usually an earlier session for this user is still open on the FortiGate — wait for its idle timeout or end it there, then retry.";
			return;
		}
		if (/login failed|failed to complete authentication|invalid (user|pass)|permission denied/i.test(line)) {
			this.lastError = "Login failed — check the username and password";
			return;
		}
		// Otherwise take the first failure-looking line.
		if (!this.lastError && /(fail|error|denied|unable|refused|timed out|invalid)/i.test(line)) {
			this.lastError = line.trim();
		}
	}
}
