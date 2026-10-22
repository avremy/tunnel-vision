import type { ChildProcess } from "node:child_process";

export type DisconnectMode = "profile" | "all";

export interface ProfileSpec {
	id: string;
	host?: string;
	port?: string;
	username?: string;
	trustedCert?: string;
	scriptPath?: string;
}

/** One item in the settings panel's Setup checklist. */
export interface SetupStep {
	id: string;
	title: string;
	ok: boolean;
	detail: string;
	/** A command the user can copy (shown in a code box with a Copy button). */
	copy?: string;
	/** A button: "run" asks the plugin to do it (runSetup), "url" opens a web page. */
	action?: { kind: "run" | "url"; label: string; url?: string };
}

/** Everything OS-specific: how passwords are stored, how a tunnel is started/stopped/detected. */
export interface Platform {
	readonly name: "mac" | "windows";
	readonly logDir: string;
	readonly defaultScript?: string;
	/** Human wording for where passwords live, e.g. "your macOS Keychain". */
	readonly passwordStoreLabel: string;
	hasPassword(id: string): Promise<boolean>;
	setPassword(id: string, password: string, label: string): Promise<void>;
	deletePassword(id: string): Promise<void>;
	/** Start the tunnel; output must end up in logFile. Returns the child if we own one (mac). Throws with a user-facing message. */
	launch(spec: ProfileSpec, logFile: string): Promise<ChildProcess | undefined>;
	stop(spec: ProfileSpec, mode: DisconnectMode): Promise<{ code: number; out: string }>;
	isRunning(spec: ProfileSpec): Promise<boolean>;
	/** Explain a failed stop (e.g. sudo/helper not set up). */
	stopFailureHint(out: string): string | undefined;
	/** Explain a log line (e.g. sudo asking for a password). */
	lineHint(line: string): string | undefined;
	/** Machine-level prerequisites (not the per-key VPN details). */
	checkSetup(spec: ProfileSpec): Promise<SetupStep[]>;
	/** Carry out a step's "run" action; returns a short message for the panel. Throws on failure. */
	runSetup(stepId: string, spec: ProfileSpec): Promise<string>;
}
