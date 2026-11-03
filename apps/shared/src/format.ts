/** Human-readable duration shared by chat progress and workbench statistics. */
export function formatDuration(milliseconds: number): string {
	const seconds = Math.max(0, Math.round(milliseconds / 1000));
	if (seconds < 60) return `${seconds} 秒`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes} 分 ${String(seconds % 60).padStart(2, "0")} 秒`;
}
