import { spawn } from "node:child_process";

export interface RunResult {
	code: number;
	stdout: string;
	out: string;
}

/** Run a program without a shell or a console window; optionally feed it stdin. */
export function run(
	file: string,
	args: string[],
	opts: { timeout?: number; env?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<RunResult> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let done = false;
		const finish = (r: RunResult) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve(r);
		};
		const child = spawn(file, args, { env: opts.env ?? process.env, windowsHide: true });
		const timer = setTimeout(() => child.kill(), opts.timeout ?? 15_000);
		child.stdout?.on("data", (d) => (stdout += d));
		child.stderr?.on("data", (d) => (stderr += d));
		child.on("error", (e) => finish({ code: -1, stdout, out: `${stdout}${stderr}${e.message}` }));
		child.on("close", (code) => finish({ code: code ?? -1, stdout, out: `${stdout}${stderr}` }));
		child.stdin?.on("error", () => undefined);
		child.stdin?.end(opts.input ?? "");
	});
}
