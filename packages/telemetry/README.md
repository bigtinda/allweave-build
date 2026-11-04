# @allweave/telemetry

Small tracing contract used by `@allweave/model` and the server. It defines spans, attributes, and schema metadata without pulling in an OpenTelemetry SDK.

## API

```ts
import { NOOP_TELEMETRY_CONTEXT, type TelemetryContext } from "@allweave/telemetry";

async function work(telemetry: TelemetryContext = NOOP_TELEMETRY_CONTEXT) {
  return telemetry.startSpan({ name: "model.request" }, async (span) => {
    span.setAttributes({ "model.provider": "openai" });
    span.addEvent("request.started");
    try {
      return await callProvider();
    } catch (error) {
      span.setStatus({ status: "error", error: { name: "ProviderError", message: String(error) } });
      throw error;
    }
  });
}
```

`NOOP_TELEMETRY_CONTEXT` performs no I/O and allocates no spans. The server can supply another `TelemetryContext` at composition time; the kernel and adapters depend only on the interface.

## Schema metadata

The package exports attribute and span schema types used by model diagnostics. Sensitive attributes are marked in metadata and must not be emitted by a production exporter.

## Tests

```powershell
npm test --workspace=@allweave/telemetry
```
