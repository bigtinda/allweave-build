export type AppPluginFieldType = "text" | "number" | "date" | "boolean" | "select";

export interface AppPluginField {
	id: string;
	label: string;
	type: AppPluginFieldType;
	required: boolean;
	options?: string[];
}

export interface AppPluginView {
	id: string;
	title: string;
	type: "table" | "board";
	groupBy?: string;
}

export interface AppPluginNavigationEntry {
	id: string;
	title: string;
	viewId: string;
}

export interface AppPluginManifest {
	manifestVersion: 1;
	id: string;
	name: string;
	version: string;
	description: string;
	fields: AppPluginField[];
	views: AppPluginView[];
	navigation: AppPluginNavigationEntry[];
}

export interface AppPluginRecord {
	id: string;
	values: Record<string, string | number | boolean>;
	createdAt: string;
	updatedAt: string;
}

export interface InstalledAppPlugin {
	digest: string;
	enabled: boolean;
	installedAt: string;
	manifest: AppPluginManifest;
}

export interface AppPluginRegistry {
	revision: number;
	plugins: InstalledAppPlugin[];
}
