import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("allweaveDesktop", {
	minimize: () => ipcRenderer.invoke("window-control", "minimize"),
	toggleMaximize: () => ipcRenderer.invoke("window-control", "toggleMaximize"),
	close: () => ipcRenderer.invoke("window-control", "close"),
	isMaximized: () => ipcRenderer.invoke("window-control", "isMaximized"),
});
