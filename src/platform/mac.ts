import { ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "./exec";
import type { Platform, ProfileSpec, SetupStep } from "./types";

/** macOS: your openfortivpn-connect.sh, passwordless sudo for pkill, passwords in the login Keychain. */
const SERVICE = "com.avremy.openfortigate";
const SECURITY = "/usr/bin/security";
const DEFAULT_SCRIPT = path.join(os.homedir(), ".local/bin/openfortivpn-connect.sh");
const env = { ...process.env, PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" };
const SUDO_RE = /password is required|terminal is required|no tty present|askpass/i;
const SUDO_HINT = "sudo wants a password — open this key's Setup steps and add the sudo rule";
const OFV_CANDIDATES = ["/opt/homebrew/bin/openfortivpn", "/usr/local/bin/openfortivpn"];
const SUDOERS_FILE = "/etc/sudoers.d/openfortivpn";

const findOpenfortivpn = () => OFV_CANDIDATES.find((p) => fs.existsSync(p));

function sudoRule(ofv: string): string {
	const user = os.userInfo().username;
	if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(user)) throw new Error(`Unexpected username "${user}"`);
	return `${user} ALL=(root) NOPASSWD: ${ofv}, /usr/bin/killall openfortivpn, /usr/bin/pkill -TERM -f openfortivpn *\n`;
}

/** Does sudo allow the commands the plugin needs without a password? (-n: never prompt) */
async function sudoReady(ofv: string): Promise<boolean> {
	const a = await run("/usr/bin/sudo", ["-n", "-l", ofv], { timeout: 5_000 });
	if (a.code !== 0) return false;
	const b = await run("/usr/bin/sudo", ["-n", "-l", "/usr/bin/pkill", "-TERM", "-f", "openfortivpn 192.0.2.1:443"], { timeout: 5_000 });
	return b.code === 0;
}

const appleScriptString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const scriptOf = (spec: ProfileSpec) => spec.scriptPath?.trim() || DEFAULT_SCRIPT;
const pattern = (spec: ProfileSpec) => (spec.host ? `openfortivpn ${spec.host}:${spec.port || "443"}` : undefined);

export const mac: Platform = {
	name: "mac",
	logDir: path.join(os.homedir(), "Library/Logs/TunnelVision"),
	defaultScript: DEFAULT_SCRIPT,
	passwordStoreLabel: "your macOS Keychain",

	async hasPassword(id) {
		return (await run(SECURITY, ["find-generic-password", "-s", SERVICE, "-a", id])).code === 0;
	},
	async setPassword(id, password, label) {
		const r = await run(SECURITY, ["add-generic-password", "-U", "-s", SERVICE, "-a", id, "-l", label, "-w", password]);
		if (r.code !== 0) throw new Error(`Keychain: ${r.out.trim() || `security exited with ${r.code}`}`);
	},
	async deletePassword(id) {
		await run(SECURITY, ["delete-generic-password", "-s", SERVICE, "-a", id]);
	},

	async launch(spec, logFile) {
		const script = scriptOf(spec);
		if (!fs.existsSync(script)) throw new Error(`Script not found: ${script}`);
		const pw = await run(SECURITY, ["find-generic-password", "-s", SERVICE, "-a", spec.id, "-w"]);
		if (pw.code !== 0) throw new Error("No password saved — enter it in the button settings");
		const args = [script, spec.host!, spec.port || "443", spec.username!, pw.stdout.replace(/\n$/, "")];
		const cert = spec.trustedCert?.trim().replace(/^sha256:/i, "");
		if (cert) args.push(cert);

		// Output goes to a file (not a pipe) so the tunnel outlives a plugin restart.
		const fd = fs.openSync(logFile, "a");
		let child: ChildProcess;
		try {
			child = spawn("/bin/bash", args, { detached: true, stdio: ["ignore", fd, fd], env });
		} finally {
			fs.closeSync(fd);
		}
		child.unref();
		return child;
	},

	async stop(spec, mode) {
		if (mode === "all") return run("/bin/bash", [scriptOf(spec), "kill"], { env });
		const p = pattern(spec);
		if (!p) return { code: 0, out: "" };
		// pkill exit 1 = nothing matched, which is fine.
		return run("/usr/bin/sudo", ["-n", "/usr/bin/pkill", "-TERM", "-f", p], { env });
	},

	async isRunning(spec) {
		const p = pattern(spec);
		if (!p) return false;
		return (await run("/usr/bin/pgrep", ["-f", p], { timeout: 5_000 })).code === 0;
	},

	stopFailureHint: (out) => (SUDO_RE.test(out) ? SUDO_HINT : undefined),
	lineHint: (line) => (SUDO_RE.test(line) ? SUDO_HINT : undefined),

	async checkSetup(spec) {
		const steps: SetupStep[] = [];
		const ofv = findOpenfortivpn();
		steps.push({
			id: "openfortivpn",
			title: "Install openfortivpn",
			ok: !!ofv,
			detail: ofv ? `Found at ${ofv}` : "Not found. Install it with Homebrew in Terminal:",
			copy: ofv ? undefined : "brew install openfortivpn",
		});

		const script = scriptOf(spec);
		steps.push({
			id: "script",
			title: "Connect script",
			ok: fs.existsSync(script),
			detail: fs.existsSync(script) ? `Using ${script}` : `Not found at ${script}. Put openfortivpn-connect.sh there, or set its path under Advanced.`,
		});

		const sudoOk = ofv ? await sudoReady(ofv) : false;
		steps.push({
			id: "sudo",
			title: "Allow connecting without a password prompt",
			ok: sudoOk,
			detail: sudoOk
				? "sudo lets Tunnel Vision start and stop openfortivpn."
				: `Stream Deck can't type your Mac password, so sudo needs a rule for openfortivpn. The button adds it to ${SUDOERS_FILE} (macOS will ask for your password once).`,
			copy: !sudoOk && ofv ? sudoRule(ofv).trim() : undefined,
			action: !sudoOk && ofv ? { kind: "run", label: "Add sudo rule" } : undefined,
		});
		return steps;
	},

	async runSetup(stepId) {
		if (stepId !== "sudo") throw new Error("Nothing to run for this step");
		const ofv = findOpenfortivpn();
		if (!ofv) throw new Error("Install openfortivpn first");
		const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tunnelvision-")), "sudoers");
		fs.writeFileSync(tmp, sudoRule(ofv), { mode: 0o600 });
		// Copy to a dotted name first (sudo ignores those), validate, then move into place.
		const sh =
			`set -e; t=/etc/sudoers.d/.tunnelvision.$$; cp '${tmp}' "$t"; chown root:wheel "$t"; chmod 0440 "$t"; ` +
			`if /usr/sbin/visudo -cf "$t" >/dev/null; then mv -f "$t" ${SUDOERS_FILE}; else rm -f "$t"; echo 'visudo rejected the rule' >&2; exit 1; fi`;
		const osa = `do shell script ${appleScriptString(sh)} with administrator privileges with prompt ${appleScriptString(
			"Tunnel Vision wants to let your user run openfortivpn with sudo without a password prompt.",
		)}`;
		try {
			const r = await run("/usr/bin/osascript", ["-e", osa], { timeout: 300_000 });
			if (r.code !== 0) throw new Error(/cancel/i.test(r.out) ? "Cancelled" : r.out.trim() || `osascript exited with ${r.code}`);
		} finally {
			fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
		}
		if (!(await sudoReady(ofv))) throw new Error("The rule was added but sudo still asks for a password");
		return "Sudo rule added.";
	},
};
