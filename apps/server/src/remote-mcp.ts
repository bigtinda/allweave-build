import { type PlatformPath, win32 } from "node:path";
import { gzipSync } from "node:zlib";
import { z } from "zod";
import { HttpError } from "./security.ts";

const stdioConfig = z
	.object({
		command: z.string().min(1),
		args: z.array(z.string()).optional(),
		env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u), z.string()).optional(),
		cwd: z.string().optional(),
	})
	.passthrough();

function quotePosix(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function quotePowerShell(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function quoteWindowsArgument(value: string): string {
	let result = '"';
	let slashes = 0;
	for (const character of value) {
		if (character === "\\") slashes++;
		else {
			result += "\\".repeat(character === '"' ? slashes * 2 + 1 : slashes) + character;
			slashes = 0;
		}
	}
	return `${result}${"\\".repeat(slashes * 2)}"`;
}

function cmdArguments(args: string[], doubleEscape: boolean): string {
	return args
		.map((arg) => {
			let escaped = quoteWindowsArgument(arg).replace(/([()\][%!^"`<>&|;, *?])/gu, "^$1");
			if (doubleEscape) escaped = escaped.replace(/([()\][%!^"`<>&|;, *?])/gu, "^$1");
			return escaped;
		})
		.join(" ");
}

function powershell(script: string): string {
	let encoded = Buffer.from(script, "utf16le").toString("base64");
	if (encoded.length > 7000) {
		const compressed = gzipSync(Buffer.from(script, "utf8")).toString("base64");
		const loader = `$stream = [IO.Compression.GZipStream]::new([IO.MemoryStream]::new([Convert]::FromBase64String('${compressed}')), [IO.Compression.CompressionMode]::Decompress); & ([scriptblock]::Create([IO.StreamReader]::new($stream).ReadToEnd()))`;
		encoded = Buffer.from(loader, "utf16le").toString("base64");
	}
	if (encoded.length > 7500)
		throw new HttpError(413, "MCP 启动参数超过 Windows SSH 命令长度限制，请缩短参数或使用主机上的启动脚本");
	return `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

function posixValue(value: string): string {
	if (value.startsWith("!")) return `"$( ${value.slice(1)} )"`;
	return value
		.split(/(\$\$|\$!|\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*)/gu)
		.map((part) => {
			if (part === "$$") return quotePosix("$");
			if (part === "$!") return quotePosix("!");
			const name =
				/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u.exec(part)?.[1] ?? /^\$([A-Za-z_][A-Za-z0-9_]*)$/u.exec(part)?.[1];
			return name ? `"\${${name}?Missing MCP environment variable}"` : quotePosix(part);
		})
		.join("");
}

function literalConfigValue(value: string): string {
	const escaped = value.split("$").join("$$");
	return escaped.startsWith("!") ? `$${escaped}` : escaped;
}

const powerShellResolver = [
	"$ErrorActionPreference = 'Stop'",
	"function Resolve-McpValue([string]$value) {",
	"  if ($value.StartsWith('!')) { return ((& ([scriptblock]::Create($value.Substring(1))) | Out-String).TrimEnd([char[]] \"`r`n\")) }",
	"  return [regex]::Replace($value, '\\$\\$|\\$!|\\$\\{([A-Za-z_][A-Za-z0-9_]*)\\}|\\$([A-Za-z_][A-Za-z0-9_]*)', { param($match)",
	"    if ($match.Value -eq '$$') { return '$' }; if ($match.Value -eq '$!') { return '!' }",
	"    $name = $match.Groups[1].Value; if (-not $name) { $name = $match.Groups[2].Value }",
	"    $resolved = [Environment]::GetEnvironmentVariable($name)",
	"    if ($null -eq $resolved) { throw ('Missing MCP environment variable: ' + $match.Groups[1].Value) }",
	"    return $resolved",
	"  })",
	"}",
].join("\n");

export function remoteMcpValueCommand(paths: PlatformPath, value: string): string {
	return paths === win32
		? powershell(`${powerShellResolver}\n[Console]::Write((Resolve-McpValue ${quotePowerShell(value)}))`)
		: `sh -c ${quotePosix(`set -e; printf '%s' ${posixValue(value)}`)}`;
}

export function remoteMcpLaunchCommand(paths: PlatformPath, home: string, root: string, input: unknown): string {
	const config = stdioConfig.parse(input);
	const expandHome = (value: string) =>
		value === "~" ? home : /^(?:~\/|~\\)/u.test(value) ? paths.join(home, value.slice(2)) : value;
	const cwd = paths.resolve(root, expandHome(config.cwd ?? "."));
	const command = expandHome(config.command);
	const args = (config.args ?? []).map(expandHome);
	if (paths === win32) {
		return powershell(
			[
				powerShellResolver,
				`Set-Location -LiteralPath ${quotePowerShell(cwd)}`,
				...Object.entries(config.env ?? {}).map(
					([key, value]) =>
						`[Environment]::SetEnvironmentVariable(${quotePowerShell(key)}, (Resolve-McpValue ${quotePowerShell(value)}), 'Process')`,
				),
				`$program = Get-Command -Name ${quotePowerShell(command)} -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1`,
				`if ($program) { $program = $program.Source } else { $program = ${quotePowerShell(command)} }`,
				"$start = New-Object System.Diagnostics.ProcessStartInfo",
				"$start.UseShellExecute = $false",
				"$start.CreateNoWindow = $true",
				"$start.RedirectStandardInput = $true",
				"$start.RedirectStandardOutput = $true",
				"$start.RedirectStandardError = $true",
				`$start.WorkingDirectory = ${quotePowerShell(cwd)}`,
				"$start.FileName = $program",
				`$start.Arguments = ${quotePowerShell(args.map(quoteWindowsArgument).join(" "))}`,
				"if ($program -match '\\.(cmd|bat)$') {",
				"  $start.FileName = $env:ComSpec",
				"  if (-not $start.FileName) { $start.FileName = 'cmd.exe' }",
				"  $escapedProgram = [regex]::Replace($program, '([()\\][%!^\"`<>&|;, *?])', '^$1')",
				`  $arguments = ${quotePowerShell(cmdArguments(args, false))}`,
				`  if ($program -match 'node_modules[\\\\/]\\.bin[\\\\/][^\\\\/]+\\.cmd$') { $arguments = ${quotePowerShell(cmdArguments(args, true))} }`,
				`  $start.Arguments = '/d /s /c "' + $escapedProgram + ' ' + $arguments + '"'`,
				"}",
				"$process = [System.Diagnostics.Process]::Start($start)",
				"$outputTask = $process.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())",
				"$errorTask = $process.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())",
				"$inputPipe = [IO.FileStream]::new($process.StandardInput.BaseStream.SafeFileHandle, [IO.FileAccess]::Write, 1, $false)",
				"$inputTask = [Console]::OpenStandardInput().CopyToAsync($inputPipe)",
				"$inputClosed = $false",
				"while (-not $process.HasExited) {",
				"  if (-not $inputClosed -and $inputTask.IsCompleted) { $inputPipe.Close(); $inputClosed = $true }",
				"  [Threading.Thread]::Sleep(20)",
				"}",
				"[void]$outputTask.GetAwaiter().GetResult()",
				"[void]$errorTask.GetAwaiter().GetResult()",
				"exit $process.ExitCode",
			].join("\n"),
		);
	}
	return `sh -c ${quotePosix(
		[
			"set -e",
			`cd -- ${quotePosix(cwd)}`,
			...Object.entries(config.env ?? {}).map(([key, value]) => `export ${key}=${posixValue(value)}`),
			`exec ${[command, ...args].map(quotePosix).join(" ")}`,
		].join("\n"),
	)}`;
}

export async function wrapRemoteMcpConfig(
	content: string,
	options: {
		paths: PlatformPath;
		home: string;
		root: string;
		ssh: string;
		sshArgs: string[];
		resolveValue: (value: string) => Promise<string>;
	},
): Promise<string> {
	const parsed = z
		.object({ mcpServers: z.record(z.string(), z.record(z.string(), z.unknown())) })
		.passthrough()
		.parse(JSON.parse(content));
	for (const [name, server] of Object.entries(parsed.mcpServers)) {
		if (typeof server.command === "string") {
			const launch = remoteMcpLaunchCommand(options.paths, options.home, options.root, server);
			const { command: _command, args: _args, env: _env, cwd: _cwd, ...rest } = server;
			parsed.mcpServers[name] = { ...rest, command: options.ssh, args: [...options.sshArgs, launch] };
		} else if (typeof server.url === "string") {
			if (server.headers !== undefined) {
				const headers = z.record(z.string(), z.string()).parse(server.headers);
				for (const [key, value] of Object.entries(headers))
					headers[key] = literalConfigValue(await options.resolveValue(value));
				server.headers = headers;
			}
			if (server.oauth && typeof server.oauth === "object" && !Array.isArray(server.oauth)) {
				const oauth = server.oauth as Record<string, unknown>;
				if (typeof oauth.clientSecret === "string")
					oauth.clientSecret = literalConfigValue(await options.resolveValue(oauth.clientSecret));
			}
		} else if (server.command !== undefined || server.url !== undefined) {
			throw new HttpError(400, `MCP 服务 ${name} 的 command 或 url 无效`);
		}
	}
	return `${JSON.stringify(parsed, null, 2)}\n`;
}
