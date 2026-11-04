# @allweave/model

Model transport for AllWeave Build. The package owns provider definitions, the model catalog, credential storage, streaming, usage accounting, and OAuth flows. It does not own the agent loop, tools, sessions, or UI.

## Layers

| Layer | Import | Purpose |
| --- | --- | --- |
| Core types | `@allweave/model` | `Model`, `Api`, messages, events, stream options |
| Model catalog | `@allweave/model/models` | `createModels`, `getModel`, catalog lookup |
| Provider factories | `@allweave/model/providers/*` | Lazy provider registration |
| Wire APIs | `@allweave/model/api/*` | Anthropic, OpenAI, Google, Bedrock, Mistral, Codex |
| Credentials | `@allweave/model/oauth` | API key and OAuth credential types |
| Compatibility | `@allweave/model/compat` | Legacy global API surface |

`@allweave/model` is side-effect free. Provider factories and API implementations are loaded lazily so a local session does not pay for providers it never uses.

## Streaming

Every API implementation returns an `AssistantMessageEventStream` with text, thinking, tool-call, usage, and completion events. `ModelGateway` in `@allweave/kernel-adapters` is the only product entry point; it converts those events into kernel `NativeModelEvent` values and tracks usage.

## Catalog

`packages/model/src/providers/data/*.json` stores provider metadata. `scripts/generate-models.ts` generates `models.generated.ts` and the public catalog. Regenerate instead of editing generated files:

```powershell
npm run generate-models --workspace=@allweave/model
```

## Tests

```powershell
npm test --workspace=@allweave/model
```

Provider tests use recorded fixtures or local fakes. They must not call paid provider APIs.
