# @allweave/sandbox

QuickJS-WASI execution sandbox for AllWeave Build code-mode tools. The package is embedded in the repository and runs as part of the local server process; there is no external sandbox service.

## Execution model

- The host (`CodemodeSandbox`) owns the tool table and the execution deadline.
- Every `execute()` call starts a fresh `node:worker_threads` worker and a fresh QuickJS VM.
- The VM can call host tools as `await tools.<name>(arg)` or `await tools["<name>"](arg)`.
- Tool arguments and results cross the boundary as JSON. Host functions run outside the VM and can be aborted.
- The worker is terminated on timeout, caller abort, or sandbox close.
- `store()` / `load()` keep small JSON values across executions; persisting them is the caller's job.

## Usage

```ts
import { CodemodeSandbox } from "@allweave/sandbox";

const sandbox = new CodemodeSandbox({
  timeoutMs: 60_000,
  memoryLimitBytes: 64 * 1024 * 1024,
  tools: [
    {
      name: "read_file",
      description: "Read a UTF-8 file",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute: async (args) => readFile((args as { path: string }).path, "utf8"),
    },
  ],
});

const result = await sandbox.execute("const text = await tools.read_file({ path: 'README.md' }); return text.length;");
if (result.ok) console.log(result.value);
else console.error(result.error);

await sandbox.close();
```

## Limits

`MAX_OUTPUT_CHARS`, `MAX_OUTPUT_ITEMS`, `MAX_STORE_VALUE_CHARS`, and `MAX_STORE_TOTAL_CHARS` bound script output and stored values. The default execution deadline is 300 seconds.

## Integration

`@allweave/kernel-adapters` exposes `createCodemodeNativeTool()` and registers the `codemode` tool when the session enables it. The kernel only sees a normal tool; it does not import QuickJS or worker code.

## Tests

```powershell
npm test --workspace=@allweave/sandbox
```
