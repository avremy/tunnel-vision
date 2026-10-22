import type { VpnStatus } from "./vpn-session";

const COLORS: Record<VpnStatus | "setup", string> = {
	disconnected: "#8E8E93",
	connecting: "#FFB020",
	disconnecting: "#FFB020",
	connected: "#30D158",
	error: "#FF453A",
	setup: "#0A84FF",
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function uptime(since?: number): string {
	if (!since) return "ON";
	const m = Math.floor((Date.now() - since) / 60_000);
	if (m < 1) return "ON";
	if (m < 60) return `ON ${m}m`;
	const h = Math.floor(m / 60);
	return `ON ${h}h${String(m % 60).padStart(2, "0")}`;
}

export interface KeyView {
	name: string;
	status: VpnStatus | "setup";
	frame: number;
	connectedSince?: number;
}

export function renderKey(v: KeyView): string {
	const c = COLORS[v.status];
	const pulsing = v.status === "connecting" || v.status === "disconnecting";
	const fillOpacity = pulsing ? (v.frame % 2 ? 0.25 : 0.7) : v.status === "connected" ? 0.9 : 0.18;
	const ink = v.status === "connected" ? "#0B0B0D" : c;

	const label = {
		disconnected: "OFF",
		connecting: "CONNECTING",
		disconnecting: "STOPPING",
		connected: uptime(v.connectedSince),
		error: "ERROR",
		setup: "SETUP",
	}[v.status];

	let glyph: string;
	switch (v.status) {
		case "connected":
			glyph = `<path d="M57 56 L68 67 L88 44" fill="none" stroke="${ink}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>`;
			break;
		case "error":
			glyph = `<path d="M72 38 V60" stroke="${ink}" stroke-width="8" stroke-linecap="round"/><circle cx="72" cy="74" r="4.5" fill="${ink}"/>`;
			break;
		case "connecting":
		case "disconnecting":
			glyph = [60, 72, 84].map((x, i) => `<circle cx="${x}" cy="58" r="4.5" fill="${ink}" opacity="${(v.frame + i) % 3 === 0 ? 1 : 0.35}"/>`).join("");
			break;
		case "setup":
			glyph = `<path d="M72 42 V74 M56 58 H88" stroke="${ink}" stroke-width="8" stroke-linecap="round"/>`;
			break;
		default:
			glyph = `<path d="M62 46 A17 17 0 1 0 82 46" fill="none" stroke="${ink}" stroke-width="6" stroke-linecap="round"/><path d="M72 38 V58" stroke="${ink}" stroke-width="6" stroke-linecap="round"/>`;
	}

	const name = v.name.length > 11 ? `${v.name.slice(0, 10)}…` : v.name;
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
<rect width="144" height="144" fill="#141416"/>
<path d="M72 14 L106 27 V55 C106 79 92 94 72 103 C52 94 38 79 38 55 V27 Z" fill="${c}" fill-opacity="${fillOpacity}" stroke="${c}" stroke-width="4" stroke-linejoin="round"/>
${glyph}
<text x="72" y="120" text-anchor="middle" font-family="-apple-system, Segoe UI, Helvetica, Arial" font-size="15" font-weight="700" fill="${c}" letter-spacing="0.5">${esc(label)}</text>
<text x="72" y="139" text-anchor="middle" font-family="-apple-system, Segoe UI, Helvetica, Arial" font-size="17" font-weight="600" fill="#FFFFFF">${esc(name)}</text>
</svg>`;
	return `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`;
}
