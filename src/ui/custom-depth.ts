/**
 * pi-missions · ui/custom-depth
 *
 * 看板靠 onTerminalInput 截键,而监听器跑在 focus 组件之前。
 * /missions、评审页、pi 自己的 confirm 一旦开着,↓ 必须交给它们,不能被看板截走。
 *
 * 没有"现在有没有 custom UI"的 pi API,所以在第一次挂监听时把
 * custom/select/confirm/input/editor 包一层,用深度计数当守卫。
 *
 * 这一层同时是**"弹出层关掉了"的唯一信号源**。焦点只在按键时经 decideWidgetNav
 * 变,而关闭弹出层没有按键 —— 不收焦点,常驻卡就继续反白、↑↓ 继续归 widget 管,
 * 失灵的是输入框的 ↑ 历史回溯。widget 自己开的两个页可以在它们的 promise 上收,
 * 但 pi 自己弹的 confirm/select/input/editor 谁也接不到 —— 只有这里接得到。
 */
const WRAPPED = Symbol.for("pi-missions.board-ui-wrapped");

let depth = 0;

type CloseListener = () => void;
const listeners = new Set<CloseListener>();

export function customUiOpen(): boolean {
	return depth > 0;
}

/**
 * 最后一个弹出层关掉时回调(depth 1 → 0)。返回退订函数。
 *
 * 只在归零时响:嵌套弹出层(状态页里再弹一个 confirm)关掉里层不算,
 * 那时焦点还该留在外层手里。
 */
export function onCustomUiClosed(fn: CloseListener): () => void {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
}

export function wrapUiForBoard(ui: any): void {
	if (!ui || ui[WRAPPED]) return;
	ui[WRAPPED] = true;
	for (const name of ["custom", "select", "confirm", "input", "editor"] as const) {
		const orig = ui[name];
		if (typeof orig !== "function") continue;
		ui[name] = (...args: unknown[]) => {
			depth++;
			let finished = false;
			const done = () => {
				if (finished) return;
				finished = true;
				depth--;
				if (depth > 0) return;
				// 订阅者的异常不能打断弹出层的收尾 —— 这里是 promise 的 finally,
				// 抛出去就是 unhandled rejection。
				for (const fn of [...listeners]) {
					try {
						fn();
					} catch {
						/* 收焦点失败不影响弹出层本身 */
					}
				}
			};
			try {
				const ret = orig.apply(ui, args);
				if (ret && typeof (ret as Promise<unknown>).then === "function") {
					return (ret as Promise<unknown>).finally(done);
				}
				done();
				return ret;
			} catch (err) {
				done();
				throw err;
			}
		};
	}
}
