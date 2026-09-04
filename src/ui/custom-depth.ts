/**
 * pi-missions · ui/custom-depth
 *
 * 看板靠 onTerminalInput 截键,而监听器跑在 focus 组件之前。
 * /missions、评审页、pi 自己的 confirm 一旦开着,↓ 必须交给它们,不能被看板截走。
 *
 * 没有"现在有没有 custom UI"的 pi API,所以在第一次挂监听时把
 * custom/select/confirm/input/editor 包一层,用深度计数当守卫。
 */
const WRAPPED = Symbol.for("pi-missions.board-ui-wrapped");

let depth = 0;

export function customUiOpen(): boolean {
	return depth > 0;
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
