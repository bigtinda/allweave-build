export const DEFAULT_ACCENT_COLOR = "#002FA7";

export const accentPresets = [
	{ name: "构序 · 克莱因蓝", color: DEFAULT_ACCENT_COLOR },
	{ name: "紫罗兰", color: "#6750A4" },
	{ name: "海蓝", color: "#3F66B5" },
	{ name: "青绿", color: "#087F72" },
	{ name: "森林", color: "#4D7852" },
	{ name: "琥珀", color: "#A45A18" },
	{ name: "玫瑰", color: "#B44F68" },
	{ name: "石墨", color: "#59616D" },
] as const;

export const fontPresets = [
	{
		id: "system",
		name: "系统默认",
		family: '"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Noto Sans CJK SC", system-ui, sans-serif',
	},
	{
		id: "yahei",
		name: "微软雅黑",
		family: '"Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", sans-serif',
	},
	{ id: "dengxian", name: "等线", family: '"DengXian", "Microsoft YaHei UI", "Segoe UI", sans-serif' },
	{ id: "simsun", name: "宋体", family: '"SimSun", "宋体", "Microsoft YaHei UI", serif' },
	{ id: "arial", name: "Arial", family: 'Arial, "Segoe UI", "Microsoft YaHei UI", sans-serif' },
] as const;

export type FontPresetId = (typeof fontPresets)[number]["id"];

export interface ThemeColors {
	primary: string;
	onPrimary: string;
	surface: string;
	container: string;
	containerLow: string;
	selected: string;
	onSelected: string;
	text: string;
	muted: string;
	outline: string;
	line: string;
}

function parseHexColor(color: string): [number, number, number] {
	const normalized = /^#[\da-f]{6}$/iu.test(color) ? color.slice(1) : DEFAULT_ACCENT_COLOR.slice(1);
	return [0, 2, 4].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16)) as [
		number,
		number,
		number,
	];
}

function toHexColor([red, green, blue]: [number, number, number]): string {
	return `#${[red, green, blue].map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
}

function mixColors(first: string, second: string, secondWeight: number): string {
	const firstRgb = parseHexColor(first);
	const secondRgb = parseHexColor(second);
	return toHexColor(
		firstRgb.map((channel, index) => channel * (1 - secondWeight) + secondRgb[index] * secondWeight) as [
			number,
			number,
			number,
		],
	);
}

function relativeLuminance(color: string): number {
	const channels = parseHexColor(color).map((channel) => {
		const normalized = channel / 255;
		return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
	});
	return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrastingText(color: string): string {
	const luminance = relativeLuminance(color);
	const whiteContrast = 1.05 / (luminance + 0.05);
	const graphiteContrast = (luminance + 0.05) / (relativeLuminance("#111111") + 0.05);
	return graphiteContrast > whiteContrast ? "#111111" : "#FFFFFF";
}

export function createThemeColors(dark: boolean, accentColor: string): ThemeColors {
	const accent = /^#[\da-f]{6}$/iu.test(accentColor) ? accentColor : DEFAULT_ACCENT_COLOR;
	const primary = dark ? mixColors(accent, "#FFFFFF", 0.58) : accent;
	const surface = dark ? "#111318" : "#FFFFFF";
	return {
		primary,
		onPrimary: contrastingText(primary),
		surface,
		container: dark ? "#1D2028" : "#F7F6F3",
		containerLow: dark ? "#171A21" : "#FBFBFA",
		selected: dark ? mixColors("#202735", accent, 0.3) : mixColors("#FFFFFF", accent, 0.08),
		onSelected: dark ? "#EEF2FF" : "#111111",
		text: dark ? "#F3F4F6" : "#2F3437",
		muted: dark ? "#B1B8C7" : "#71706C",
		outline: dark ? "#7B8496" : "#9CA3AF",
		line: dark ? "#303644" : "#EAEAEA",
	};
}

export function getFontFamily(fontId: string): string {
	return fontPresets.find((font) => font.id === fontId)?.family ?? fontPresets[0].family;
}
