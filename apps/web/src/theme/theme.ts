import { createTheme } from "@mui/material/styles";
import { SpringCollapse } from "../components/SpringCollapse.tsx";
import { SpringTransition } from "../components/SpringTransition.tsx";
import { motionTokens } from "./motion.ts";
import { createThemeColors, DEFAULT_ACCENT_COLOR, fontPresets } from "./personalization.ts";

export function consoleTheme(
	dark: boolean,
	accentColor = DEFAULT_ACCENT_COLOR,
	fontId = "system",
	reducedMotion = false,
) {
	const colors = createThemeColors(dark, accentColor);
	const motionDuration = (duration: number) => (reducedMotion ? 0 : duration);
	return createTheme({
		palette: {
			mode: dark ? "dark" : "light",
			primary: { main: colors.primary, contrastText: colors.onPrimary },
			secondary: { main: colors.muted },
			background: { default: colors.surface, paper: colors.container },
			text: { primary: colors.text, secondary: colors.muted },
			divider: colors.line,
			error: { main: dark ? "#FFB4AB" : "#B3261E" },
		},
		shape: { borderRadius: 6 },
		spacing: 8,
		transitions: {
			easing: {
				easeInOut: motionTokens.easing.spring,
				easeOut: motionTokens.easing.spring,
				easeIn: motionTokens.easing.exit,
				sharp: motionTokens.easing.exit,
			},
			duration: {
				shortest: motionDuration(motionTokens.duration.instant),
				shorter: motionDuration(motionTokens.duration.fast),
				short: motionDuration(motionTokens.duration.fast),
				standard: motionDuration(motionTokens.duration.normal),
				complex: motionDuration(motionTokens.duration.slow),
				enteringScreen: motionDuration(motionTokens.duration.normal),
				leavingScreen: motionDuration(motionTokens.duration.fast),
			},
		},
		typography: {
			fontFamily: fontPresets.find((font) => font.id === fontId)?.family ?? fontPresets[0].family,
			body1: { fontSize: "0.875rem", lineHeight: 1.6 },
			body2: { fontSize: "0.875rem", lineHeight: 1.6 },
			h4: { fontSize: "2.25rem", fontWeight: 600, letterSpacing: "-0.04em" },
			h5: { fontWeight: 600, letterSpacing: "-0.025em" },
			button: { fontSize: "0.8125rem", textTransform: "none", fontWeight: 500 },
		},
		components: {
			MuiCircularProgress: {
				defaultProps: { disableShrink: true, size: 20, thickness: 4, "aria-label": "正在加载" },
				styleOverrides: { root: { animation: reducedMotion ? "none" : undefined } },
			},
			MuiButtonBase: { defaultProps: { disableRipple: true } },
			MuiButton: {
				defaultProps: { disableElevation: true },
				styleOverrides: {
					root: { borderRadius: 6, paddingInline: 12, minHeight: 34, lineHeight: 1.4 },
					outlined: { borderColor: colors.outline },
				},
			},
			MuiIconButton: { styleOverrides: { root: { padding: 8, borderRadius: 6, color: colors.muted } } },
			MuiTextField: { defaultProps: { size: "small" } },
			MuiOutlinedInput: {
				styleOverrides: {
					root: { borderRadius: 6, fontSize: 13, background: colors.surface },
					input: { padding: "9px 12px" },
					notchedOutline: { borderColor: colors.outline },
				},
			},
			MuiPaper: {
				defaultProps: { elevation: 0 },
				styleOverrides: { root: { backgroundImage: "none" } },
			},
			MuiDrawer: {
				defaultProps: {
					slots: { transition: SpringTransition },
					slotProps: { transition: { preset: "smooth", direction: "left", distance: 22 } },
				},
				styleOverrides: { paper: { backgroundImage: "none" } },
			},
			MuiAccordion: {
				defaultProps: { slots: { transition: SpringCollapse }, disableGutters: true },
				styleOverrides: {
					root: {
						background: "transparent",
						boxShadow: "none",
						borderBottom: `1px solid ${colors.line}`,
						"&::before": { display: "none" },
					},
				},
			},
			MuiAccordionSummary: {
				styleOverrides: { root: { minHeight: 48, paddingInline: 16 }, content: { marginBlock: 12 } },
			},
			MuiTab: {
				styleOverrides: { root: { textTransform: "none", minHeight: 38, fontSize: 13, fontWeight: 500 } },
			},
			MuiMenuItem: { styleOverrides: { root: { minHeight: 34, fontSize: 13, borderRadius: 4 } } },
			MuiDialog: {
				styleOverrides: { paper: { borderRadius: 10, border: `1px solid ${colors.line}` } },
				defaultProps: {
					slots: { transition: SpringTransition },
					transitionDuration: motionDuration(motionTokens.duration.normal),
				},
			},
			MuiMenu: {
				defaultProps: {
					slots: { transition: SpringTransition },
					transitionDuration: motionDuration(motionTokens.duration.normal),
				},
			},
			MuiPopover: {
				defaultProps: {
					slots: { transition: SpringTransition },
					transitionDuration: motionDuration(motionTokens.duration.normal),
				},
			},
			MuiSnackbar: { defaultProps: { slots: { transition: SpringTransition } } },
			MuiChip: { styleOverrides: { root: { borderRadius: 4, fontSize: 12, height: 24 } } },
		},
	});
}
