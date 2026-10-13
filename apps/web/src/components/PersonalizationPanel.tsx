import { Alert, Button, FormControl, InputLabel, MenuItem, Select } from "@mui/material";
import { ImagePlus, Palette, Type, X } from "lucide-react";
import type { CSSProperties } from "react";
import { useRef, useState } from "react";
import { usePreferences } from "../stores/preferences.ts";
import { accentPresets, fontPresets } from "../theme/personalization.ts";
import { prepareWallpaper } from "../theme/wallpaper.ts";

export function PersonalizationPanel() {
	const accentColor = usePreferences((state) => state.accentColor);
	const fontId = usePreferences((state) => state.fontId);
	const wallpaper = usePreferences((state) => state.wallpaper);
	const storedWallpaperAccentColor = usePreferences((state) => state.wallpaperAccentColor);
	const setAccentColor = usePreferences((state) => state.setAccentColor);
	const setFontId = usePreferences((state) => state.setFontId);
	const setWallpaper = usePreferences((state) => state.setWallpaper);
	const clearWallpaper = usePreferences((state) => state.clearWallpaper);
	const fileInput = useRef<HTMLInputElement>(null);
	const [uploading, setUploading] = useState(false);
	const [error, setError] = useState("");
	const hasCustomAccent = !accentPresets.some((preset) => preset.color.toLowerCase() === accentColor.toLowerCase());
	const wallpaperAccentColor = storedWallpaperAccentColor || (wallpaper && hasCustomAccent ? accentColor : "");

	const uploadWallpaper = async (file: File | undefined) => {
		if (!file) return;
		setUploading(true);
		setError("");
		try {
			const prepared = await prepareWallpaper(file);
			setWallpaper(prepared.dataUrl, prepared.accentColor);
		} catch (uploadError) {
			setError(uploadError instanceof Error ? uploadError.message : String(uploadError));
		} finally {
			setUploading(false);
			if (fileInput.current) fileInput.current.value = "";
		}
	};

	return (
		<section className="personalization-panel" aria-labelledby="personalization-title">
			<div className="personalization-heading">
				<div className="personalization-heading-icon">
					<Palette size={19} />
				</div>
				<div>
					<h3 id="personalization-title">页面个性化</h3>
					<p className="muted">自定义工作台壁纸、主题色和界面字体，设置会保存在此浏览器中。</p>
				</div>
			</div>

			<div className="personalization-grid">
				<div className="personalization-card wallpaper-card">
					<div className="personalization-card-title">
						<ImagePlus size={17} />
						<strong>壁纸</strong>
					</div>
					<p className="muted">上传图片后会自动提取主色，并设置为当前主题色。</p>
					<div className={`wallpaper-preview${wallpaper ? " has-wallpaper" : ""}`}>
						{wallpaper ? <img src={wallpaper} alt="当前工作台壁纸预览" /> : <span>尚未设置壁纸</span>}
					</div>
					<div className="personalization-actions">
						<input
							ref={fileInput}
							className="visually-hidden"
							type="file"
							accept="image/*"
							onChange={(event) => void uploadWallpaper(event.target.files?.[0])}
						/>
						<Button
							variant="contained"
							startIcon={<ImagePlus size={16} />}
							disabled={uploading}
							onClick={() => fileInput.current?.click()}
						>
							{uploading ? "处理中…" : wallpaper ? "更换壁纸" : "上传壁纸"}
						</Button>
						{wallpaper && (
							<Button color="inherit" startIcon={<X size={15} />} onClick={clearWallpaper}>
								移除
							</Button>
						)}
					</div>
				</div>

				<div className="personalization-card accent-card">
					<div className="personalization-card-title">
						<Palette size={17} />
						<strong>主题色</strong>
					</div>
					<p className="muted">选择预设颜色，或使用壁纸提取的主色。</p>
					<fieldset className="accent-swatches">
						<legend className="visually-hidden">选择主题色</legend>
						{accentPresets.map((preset) => (
							<button
								key={preset.color}
								type="button"
								className={`accent-swatch${accentColor.toLowerCase() === preset.color.toLowerCase() ? " active" : ""}`}
								style={{ "--swatch-color": preset.color } as CSSProperties}
								aria-label={`${preset.name}主题色`}
								aria-pressed={accentColor.toLowerCase() === preset.color.toLowerCase()}
								title={preset.name}
								onClick={() => setAccentColor(preset.color)}
							>
								<span />
							</button>
						))}
						{wallpaperAccentColor && (
							<button
								type="button"
								className={`accent-swatch custom${accentColor.toLowerCase() === wallpaperAccentColor.toLowerCase() ? " active" : ""}`}
								style={{ "--swatch-color": wallpaperAccentColor } as CSSProperties}
								aria-label={`使用壁纸提取的主题色 ${wallpaperAccentColor}`}
								aria-pressed={accentColor.toLowerCase() === wallpaperAccentColor.toLowerCase()}
								title={`壁纸提取 ${wallpaperAccentColor}`}
								onClick={() => setAccentColor(wallpaperAccentColor)}
							>
								<span />
							</button>
						)}
					</fieldset>
					<div className="accent-current">
						<span className="accent-current-dot" style={{ backgroundColor: accentColor }} />
						<span>当前颜色</span>
						<code>{accentColor.toUpperCase()}</code>
						{wallpaperAccentColor && accentColor.toLowerCase() === wallpaperAccentColor.toLowerCase() && (
							<span className="muted">壁纸提取</span>
						)}
					</div>
				</div>

				<div className="personalization-card font-card">
					<div className="personalization-card-title">
						<Type size={17} />
						<strong>界面字体</strong>
					</div>
					<p className="muted">优先使用所选字体，若系统未安装则自动回退。</p>
					<FormControl fullWidth size="small">
						<InputLabel id="personalization-font-label">字体</InputLabel>
						<Select
							labelId="personalization-font-label"
							label="字体"
							value={fontId}
							onChange={(event) => setFontId(event.target.value)}
						>
							{fontPresets.map((font) => (
								<MenuItem key={font.id} value={font.id}>
									{font.name}
								</MenuItem>
							))}
						</Select>
					</FormControl>
					<div className="font-sample">AllWeave Build · 构序 · 一念成潮，万象成序。</div>
				</div>
			</div>
			{error && (
				<Alert severity="error" onClose={() => setError("")}>
					{error}
				</Alert>
			)}
		</section>
	);
}
