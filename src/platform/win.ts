import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./exec";
import type { Platform, ProfileSpec, SetupStep } from "./types";

/**
 * Windows: openconnect (--protocol=fortinet) started by an elevated helper.
 *
 * Setup-TunnelVision.ps1 (run once as admin) installs the helper to Program Files and registers two
 * scheduled tasks that run it with highest privileges. The plugin never elevates itself; it:
 *   1. writes profiles\<id>.json (no secrets) and keeps profiles\<id>.pw (DPAPI-encrypted for this user),
 *   2. drops requests\<id>.connect / <id>.stop / all.stop,
 *   3. runs `schtasks /run` on the matching task.
 * The helper appends openconnect's output to logs\<id>.log and writes run\<id>.pid.
 */
const BASE = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "TunnelVision");
const DIRS = {
	profiles: path.join(BASE, "profiles"),
	requests: path.join(BASE, "requests"),
	run: path.join(BASE, "run"),
	logs: path.join(BASE, "logs"),
};
const SYS = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
const SCHTASKS = path.join(SYS, "schtasks.exe");
const TASKLIST = path.join(SYS, "tasklist.exe");
const POWERSHELL = path.join(SYS, "WindowsPowerShell", "v1.0", "powershell.exe");
const TASK_CONNECT = "TunnelVision Connect";
const TASK_STOP = "TunnelVision Stop";
const HELPER_HINT = "Windows helper isn't set up — open this key's Setup steps and click Run setup";
const DOWNLOAD_URL = "https://gui.openconnect-vpn.net/download/";

// bin/plugin.js → the .sdPlugin folder, which ships windows/Setup-TunnelVision.ps1 and the helper.
const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLED_SETUP = path.join(PLUGIN_DIR, "windows", "Setup-TunnelVision.ps1");
const BUNDLED_HELPER = path.join(PLUGIN_DIR, "windows", "tunnelvision-helper.ps1");
const INSTALL_DIR = path.join(process.env.ProgramFiles ?? "C:\\Program Files", "TunnelVision");

const fileHash = (p: string): string | undefined => {
	try {
		const text = fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
		return crypto.createHash("sha256").update(text).digest("hex");
	} catch {
		return undefined;
	}
};

async function findOpenconnect(): Promise<string | undefined> {
	const pf = process.env.ProgramFiles ?? "C:\\Program Files";
	const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
	const candidates = [
		path.join(pf, "OpenConnect-GUI", "openconnect.exe"),
		path.join(pf86, "OpenConnect-GUI", "openconnect.exe"),
		path.join(pf, "OpenConnect", "openconnect.exe"),
		"C:\\msys64\\mingw64\\bin\\openconnect.exe",
		"C:\\msys64\\ucrt64\\bin\\openconnect.exe",
	];
	const found = candidates.find((c) => fs.existsSync(c));
	if (found) return found;
	const r = await run(path.join(SYS, "where.exe"), ["openconnect.exe"], { timeout: 5_000 });
	return r.code === 0 ? r.stdout.split(/\r?\n/)[0].trim() || undefined : undefined;
}

async function helperState(): Promise<{ ok: boolean; detail: string }> {
	const tasks = await Promise.all([TASK_CONNECT, TASK_STOP].map((t) => run(SCHTASKS, ["/query", "/tn", t], { timeout: 10_000 })));
	if (tasks.some((t) => t.code !== 0)) return { ok: false, detail: "Not set up yet." };
	let cfg: { OpenConnect?: string } = {};
	try {
		cfg = JSON.parse(fs.readFileSync(path.join(INSTALL_DIR, "config.json"), "utf8").replace(/^\uFEFF/, ""));
	} catch {
		return { ok: false, detail: "Helper files are missing." };
	}
	if (!cfg.OpenConnect || !fs.existsSync(cfg.OpenConnect)) {
		return { ok: false, detail: `The helper points at an openconnect.exe that no longer exists (${cfg.OpenConnect ?? "none"}).` };
	}
	if (fileHash(BUNDLED_HELPER) !== fileHash(path.join(INSTALL_DIR, "tunnelvision-helper.ps1"))) {
		return { ok: false, detail: "The installed helper is from an older version of the plugin." };
	}
	return { ok: true, detail: `Ready — using ${cfg.OpenConnect}` };
}

// Same rules the helper enforces (the helper is the real security boundary).
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const HOST_RE = /^(?:[A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:.]{2,45}\])$/;
const USER_RE = /^[^\x00-\x1f]{1,256}$/;
const CERT_RE = /^(?:pin-sha256:[A-Za-z0-9+/]{43}=|sha256:[0-9A-Fa-f]{64}|[0-9A-Fa-f]{64})$/;

function ensureDirs(): void {
	for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });
}

function checkId(id: string): string {
	if (!ID_RE.test(id)) throw new Error("Invalid profile id");
	return id;
}

const pwFile = (id: string) => path.join(DIRS.profiles, `${checkId(id)}.pw`);

async function runTask(name: string) {
	return run(SCHTASKS, ["/run", "/tn", name], { timeout: 15_000 });
}

export const win: Platform = {
	name: "windows",
	logDir: DIRS.logs,
	passwordStoreLabel: "Windows (DPAPI-encrypted for your user)",

	async hasPassword(id) {
		return fs.existsSync(pwFile(id));
	},

	async setPassword(id, password) {
		ensureDirs();
		// Password goes in on stdin, never on a command line.
		const script =
			"[Console]::InputEncoding=[Text.Encoding]::UTF8;" +
			"$p=[Console]::In.ReadToEnd();" +
			"ConvertTo-SecureString -String $p -AsPlainText -Force | ConvertFrom-SecureString | " +
			"Set-Content -LiteralPath $env:TV_PWFILE -Encoding ASCII";
		const r = await run(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", script], {
			env: { ...process.env, TV_PWFILE: pwFile(id) },
			input: password,
		});
		if (r.code !== 0 || !fs.existsSync(pwFile(id))) throw new Error(`Could not save password: ${r.out.trim() || `exit ${r.code}`}`);
	},

	async deletePassword(id) {
		fs.rmSync(pwFile(id), { force: true });
	},

	async launch(spec) {
		ensureDirs();
		const id = checkId(spec.id);
		const host = spec.host?.trim() ?? "";
		const port = (spec.port || "443").trim();
		const username = spec.username?.trim() ?? "";
		const cert = spec.trustedCert?.trim() || undefined;
		if (!HOST_RE.test(host)) throw new Error("Gateway must be a hostname or IP address");
		if (!/^\d{1,5}$/.test(port) || +port < 1 || +port > 65535) throw new Error("Port must be 1–65535");
		if (!USER_RE.test(username)) throw new Error("Username is empty or invalid");
		if (cert && !CERT_RE.test(cert)) throw new Error("Trusted cert must be a SHA256 hex fingerprint or pin-sha256:…");
		if (!fs.existsSync(pwFile(id))) throw new Error("No password saved — enter it in the button settings");

		fs.writeFileSync(path.join(DIRS.profiles, `${id}.json`), JSON.stringify({ host, port, username, trustedCert: cert ?? "" }));
		const req = path.join(DIRS.requests, `${id}.connect`);
		fs.writeFileSync(req, String(Date.now()));
		const r = await runTask(TASK_CONNECT);
		if (r.code !== 0) {
			fs.rmSync(req, { force: true });
			throw new Error(/access is denied/i.test(r.out) ? `Access denied starting the helper task. ${HELPER_HINT}` : HELPER_HINT);
		}
		return undefined;
	},

	async stop(spec, mode) {
		ensureDirs();
		const name = mode === "all" ? "all" : checkId(spec.id);
		fs.writeFileSync(path.join(DIRS.requests, `${name}.stop`), String(Date.now()));
		return runTask(TASK_STOP);
	},

	async isRunning(spec) {
		if (!ID_RE.test(spec.id)) return false;
		let pid: number;
		try {
			pid = parseInt(fs.readFileSync(path.join(DIRS.run, `${spec.id}.pid`), "utf8").trim(), 10);
		} catch {
			return false;
		}
		if (!Number.isInteger(pid) || pid <= 0) return false;
		const r = await run(TASKLIST, ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { timeout: 5_000 });
		return /"openconnect\.exe"/i.test(r.stdout);
	},

	stopFailureHint: (out) => (/cannot find|does not exist|access is denied/i.test(out) ? HELPER_HINT : undefined),
	lineHint: () => undefined,

	async checkSetup() {
		const oc = await findOpenconnect();
		const steps: SetupStep[] = [
			{
				id: "openconnect",
				title: "Install OpenConnect",
				ok: !!oc,
				detail: oc
					? `Found at ${oc}`
					: "Download OpenConnect-GUI. In the installer, tick the “command-line / console version” component — that's the part Tunnel Vision uses. Then click Re-check.",
				action: oc ? undefined : { kind: "url", label: "Download OpenConnect-GUI", url: DOWNLOAD_URL },
			},
		];
		const helper = oc ? await helperState() : { ok: false, detail: "Install OpenConnect first." };
		steps.push({
			id: "helper",
			title: "Allow connecting without UAC prompts",
			ok: helper.ok,
			detail: helper.ok
				? helper.detail
				: `${helper.detail} Click Run setup and approve the one Windows admin prompt — it registers a helper so key presses never ask again.`,
			action: helper.ok || !oc ? undefined : { kind: "run", label: "Run setup" },
		});
		return steps;
	},

	async runSetup(stepId) {
		if (stepId !== "helper") throw new Error("Nothing to run for this step");
		if (!fs.existsSync(BUNDLED_SETUP)) throw new Error(`Setup script missing from the plugin (${BUNDLED_SETUP})`);
		const oc = await findOpenconnect();
		if (!oc) throw new Error("Install OpenConnect first");
		ensureDirs();
		const result = path.join(BASE, "setup-result.txt");
		fs.rmSync(result, { force: true });
		// Elevate only the setup script (one UAC prompt). Values travel via env vars to avoid quoting issues.
		const script =
			"$a = '-NoProfile -ExecutionPolicy Bypass -File \"' + $env:TV_SETUP + '\" -OpenConnectPath \"' + $env:TV_OC + " +
			"'\" -User \"' + $env:TV_USER + '\" -ResultFile \"' + $env:TV_RESULT + '\"';" +
			"Start-Process -FilePath powershell.exe -Verb RunAs -Wait -ArgumentList $a";
		// -EncodedCommand (UTF-16LE base64) sidesteps Windows PowerShell's quirky quote handling.
		const encoded = Buffer.from(script, "utf16le").toString("base64");
		const r = await run(POWERSHELL, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
			timeout: 600_000,
			env: {
				...process.env,
				TV_SETUP: BUNDLED_SETUP,
				TV_OC: oc,
				TV_USER: `${process.env.USERDOMAIN ?? os.hostname()}\\${process.env.USERNAME ?? os.userInfo().username}`,
				TV_RESULT: result,
			},
		});
		let outcome = "";
		try {
			outcome = fs.readFileSync(result, "utf8").replace(/^\uFEFF/, "").trim();
		} catch {
			/* no result file */
		}
		if (outcome === "OK") return "Setup complete.";
		if (outcome.startsWith("ERROR:")) throw new Error(outcome.slice(6).trim());
		if (r.code !== 0) throw new Error(/cancel/i.test(r.out) ? "Cancelled at the Windows admin prompt" : r.out.trim() || `exit ${r.code}`);
		throw new Error("Setup window closed without reporting a result");
	},
};
