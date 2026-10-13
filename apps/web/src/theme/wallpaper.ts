const MAX_WALLPAPER_BYTES = 12 * 1024 * 1024;
const MAX_WALLPAPER_DATA_URL_LENGTH = 3 * 1024 * 1024;

export interface PreparedWallpaper {
	dataUrl: string;
	accentColor: string;
}

function dominantColor(bitmap: ImageBitmap): string {
	const canvas = document.createElement("canvas");
	canvas.width = 48;
	canvas.height = 48;
	const context = canvas.getContext("2d", { willReadFrequently: true });
	if (!context) throw new Error("无法读取图片颜色");
	context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
	const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
	const buckets = new Map<string, { count: number; red: number; green: number; blue: number }>();
	let neutral = { count: 0, red: 0, green: 0, blue: 0 };
	for (let index = 0; index < pixels.length; index += 4) {
		const alpha = pixels[index + 3];
		if (alpha < 160) continue;
		const red = pixels[index];
		const green = pixels[index + 1];
		const blue = pixels[index + 2];
		const maximum = Math.max(red, green, blue);
		const minimum = Math.min(red, green, blue);
		neutral = {
			count: neutral.count + 1,
			red: neutral.red + red,
			green: neutral.green + green,
			blue: neutral.blue + blue,
		};
		if (maximum === 0 || (maximum - minimum) / maximum < 0.12) continue;
		const key = `${red >> 4}:${green >> 4}:${blue >> 4}`;
		const bucket = buckets.get(key) ?? { count: 0, red: 0, green: 0, blue: 0 };
		bucket.count += 1;
		bucket.red += red;
		bucket.green += green;
		bucket.blue += blue;
		buckets.set(key, bucket);
	}
	const dominant = [...buckets.values()].sort((first, second) => second.count - first.count)[0] ?? neutral;
	if (dominant.count === 0) return "#6750A4";
	return `#${[dominant.red, dominant.green, dominant.blue]
		.map((channel) =>
			Math.round(channel / dominant.count)
				.toString(16)
				.padStart(2, "0"),
		)
		.join("")}`;
}

function encodeWallpaper(canvas: HTMLCanvasElement, quality: number): string {
	const dataUrl = canvas.toDataURL("image/webp", quality);
	return dataUrl.startsWith("data:image/webp;") ? dataUrl : canvas.toDataURL("image/jpeg", quality);
}

export async function prepareWallpaper(file: File): Promise<PreparedWallpaper> {
	if (!file.type.startsWith("image/")) throw new Error("请选择图片文件");
	if (file.size > MAX_WALLPAPER_BYTES) throw new Error("壁纸原文件不能超过 12 MB");

	const bitmap = await createImageBitmap(file);
	try {
		if (bitmap.width * bitmap.height > 80_000_000) throw new Error("图片分辨率过高，请先缩小后再上传");
		const scale = Math.min(1, 1600 / bitmap.width, 1000 / bitmap.height);
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(bitmap.width * scale));
		canvas.height = Math.max(1, Math.round(bitmap.height * scale));
		const context = canvas.getContext("2d");
		if (!context) throw new Error("无法处理这张图片");
		context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

		let dataUrl = encodeWallpaper(canvas, 0.82);
		if (dataUrl.length > MAX_WALLPAPER_DATA_URL_LENGTH) {
			const smallerCanvas = document.createElement("canvas");
			const smallerScale = Math.min(1, 1200 / bitmap.width, 750 / bitmap.height);
			smallerCanvas.width = Math.max(1, Math.round(bitmap.width * smallerScale));
			smallerCanvas.height = Math.max(1, Math.round(bitmap.height * smallerScale));
			const smallerContext = smallerCanvas.getContext("2d");
			if (!smallerContext) throw new Error("无法压缩这张图片");
			smallerContext.drawImage(bitmap, 0, 0, smallerCanvas.width, smallerCanvas.height);
			dataUrl = encodeWallpaper(smallerCanvas, 0.7);
		}
		if (dataUrl.length > MAX_WALLPAPER_DATA_URL_LENGTH) throw new Error("压缩后的壁纸仍然过大，请选择较小的图片");
		return { dataUrl, accentColor: dominantColor(bitmap) };
	} finally {
		bitmap.close();
	}
}
