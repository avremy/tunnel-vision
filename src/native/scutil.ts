import { run } from "../platform/exec";

/**
 * macOS "native" VPNs — the ones in System Settings → VPN (IKEv2/IPSec/L2TP, and VPN apps that
 * register a system VPN such as FortiClient, Tailscale or WireGuard). Driven with `scutil --nc`.
 */
const SCUTIL = "/usr/sbin/scutil";

export type NcStatus = "Connected" | "Connecting" | "Disconnected" | "Disconnecting" | "Invalid" | string;

export interface NcService {
	id: string;
	name: string;
	/** e.g. "IPSec", "PPP/L2TP", "VPN:io.tailscale.ipn.macsys" */
	kind: string;
	status: NcStatus;
}

// * (Disconnected)   1A33A499-EC26-4429-91F3-ADC52AAE3C54 IPSec              "Lev Hatora"     [IPSec]
const LINE = /^\s*\*?\s*\(([^)]+)\)\s+([0-9A-Fa-f-]{36})\s+.*?"(.*)"\s+\[(.*)\]\s*$/;

export async function listServices(): Promise<NcService[]> {
	const r = await run(SCUTIL, ["--nc", "list"], { timeout: 8_000 });
	if (r.code !== 0) throw new Error(r.out.trim() || `scutil exited with ${r.code}`);
	const out: NcService[] = [];
	for (const line of r.stdout.split("\n")) {
		const m = line.match(LINE);
		if (m) out.push({ status: m[1].trim(), id: m[2], name: m[3], kind: m[4].trim() });
	}
	return out;
}

export async function start(id: string): Promise<void> {
	const r = await run(SCUTIL, ["--nc", "start", id], { timeout: 15_000 });
	if (r.code !== 0) throw new Error(r.out.trim() || `scutil exited with ${r.code}`);
}

export async function stop(id: string): Promise<void> {
	const r = await run(SCUTIL, ["--nc", "stop", id], { timeout: 15_000 });
	if (r.code !== 0) throw new Error(r.out.trim() || `scutil exited with ${r.code}`);
}
