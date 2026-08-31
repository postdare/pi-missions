/**
 * pi-missions · hooks/diagnostics
 *
 * 编辑级反馈(§8.2 · 最小干预):lint/类型检查是每次编辑后立刻可得的,
 * 没理由攒到 CHECK。edit/write 成功后后台跑配置的增量检查命令,
 * 发现问题当场以 steer 回灌 —— 内层循环的粒度从任务级降到编辑级。
 *
 * 命令来自 .pi/pi-missions.json 的 incrementalCheck;未配置则关闭。
 * 通用扩展无法发明跨语言的增量检查器,这是诚实的边界。
 */

type Exec = (cmd: string, args: string[], opts?: { cwd?: string; timeout?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;

const DEBOUNCE_MS = 800;
const TIMEOUT_MS = 60_000;

export class IncrementalDiagnostics {
	private timer: ReturnType<typeof setTimeout> | null = null;
	private running = false;
	private dirty = false;

	private readonly exec: Exec;
	private readonly cwd: string;
	private readonly command: string;
	private readonly push: (text: string) => void;

	constructor(exec: Exec, cwd: string, command: string, push: (text: string) => void) {
		this.exec = exec;
		this.cwd = cwd;
		this.command = command;
		this.push = push;
	}

	/** edit/write 成功后调用;防抖合并连续编辑 */
	poke(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.run(), DEBOUNCE_MS);
	}

	dispose(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
	}

	private async run(): Promise<void> {
		if (this.running) {
			this.dirty = true;
			return;
		}
		this.running = true;
		try {
			const r = await this.exec("bash", ["-c", this.command], { cwd: this.cwd, timeout: TIMEOUT_MS });
			if (r.code !== 0) {
				const tail = `${r.stdout}\n${r.stderr}`.trim().split("\n").slice(-30).join("\n");
				this.push(`增量检查(${this.command})失败,当场修复再继续:\n${tail}`);
			}
		} catch {
			// 检查器本身失败不打扰执行者
		} finally {
			this.running = false;
			if (this.dirty) {
				this.dirty = false;
				this.poke();
			}
		}
	}
}
