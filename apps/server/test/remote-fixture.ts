import { type PlatformPath, posix, win32 } from "node:path";
import { type Connection, packagedDaemon, RemoteExecutionEnv } from "@earendil-works/pi-env";
import { RemoteWorkspaceService } from "../src/remote-workspaces.ts";

const platform = process.platform === "win32" ? "windows" : process.platform;
export const daemon =
	(platform === "linux" || platform === "darwin" || platform === "windows") &&
	(process.arch === "x64" || process.arch === "arm64")
		? packagedDaemon({ platform, arch: process.arch })
		: undefined;

export class LoopbackRemoteWorkspaces extends RemoteWorkspaceService {
	private transport: Connection;
	private paths: PlatformPath;
	private home?: string;

	constructor(
		directory: string,
		transport: Connection,
		paths = process.platform === "win32" ? win32 : posix,
		home?: string,
	) {
		super(directory);
		this.transport = transport;
		this.paths = paths;
		this.home = home;
	}

	override async environment(host: string, cwd = ".") {
		const info = await this.transport.info();
		return {
			env: new RemoteExecutionEnv({ connection: this.transport, id: host, cwd }),
			paths: this.paths,
			home: this.home ?? info.home,
		};
	}
}
