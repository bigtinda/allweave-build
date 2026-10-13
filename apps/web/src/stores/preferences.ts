import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_ACCENT_COLOR } from "../theme/personalization.ts";

interface Preferences {
	dark: boolean;
	panel: boolean;
	sidebar: boolean;
	accentColor: string;
	fontId: string;
	wallpaper: string;
	wallpaperAccentColor: string;
	toggleTheme: () => void;
	togglePanel: () => void;
	toggleSidebar: () => void;
	setAccentColor: (accentColor: string) => void;
	setFontId: (fontId: string) => void;
	setWallpaper: (wallpaper: string, accentColor: string) => void;
	clearWallpaper: () => void;
}
export const usePreferences = create<Preferences>()(
	persist(
		(set) => ({
			dark: false,
			panel: true,
			sidebar: true,
			accentColor: DEFAULT_ACCENT_COLOR,
			fontId: "system",
			wallpaper: "",
			wallpaperAccentColor: "",
			toggleTheme: () => set((state) => ({ dark: !state.dark })),
			togglePanel: () => set((state) => ({ panel: !state.panel })),
			toggleSidebar: () => set((state) => ({ sidebar: !state.sidebar })),
			setAccentColor: (accentColor) => set({ accentColor }),
			setFontId: (fontId) => set({ fontId }),
			setWallpaper: (wallpaper, wallpaperAccentColor) =>
				set({ wallpaper, wallpaperAccentColor, accentColor: wallpaperAccentColor }),
			clearWallpaper: () => set({ wallpaper: "", wallpaperAccentColor: "" }),
		}),
		{ name: "pi-console-preferences" },
	),
);

export const DEFAULT_COMPOSER_KEYBINDINGS = { send: "Enter" } as const;
