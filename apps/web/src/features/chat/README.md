# Chat feature

`App.tsx` composes this feature through `index.ts`, which exports `ChatPage`.
The route inputs remain `workspaces`, `sessions` and `onNew`; the router still
owns `/`, `/sessions/:id` and the welcome fallback.

| File | Responsibility |
| --- | --- |
| `ChatPage.tsx` | Conversation, timeline, approvals, recall/branch/recovery, drafts and workspace panel composition |
| `useSession.ts` | Session query, WebSocket snapshots/events, reconnect and cache invalidation |
| `Composer.tsx` | Message submission, attachments, model/thinking/access controls and abort |
| `Markdown.tsx` | Chat Markdown and code copying |
| `UsageSummary.tsx` | Existing cumulative token/cache usage display |

Use `services/api.ts` for HTTP and `@allweave/protocol` for DTOs and
`applyEvent`. Query keys, reconnect backoff and the preference store retain their
existing behavior. CSS remains in the existing global stylesheets.

Shared presentation components and `WorkspacePanel` remain in `components/`.
The panel accepts shared DTOs and callbacks; chat does not import another
feature, server implementation or model SDK. Workspace/browser ownership has not
been migrated in this step. New feature dependencies must respect the boundary
test in `apps/web/test/feature-boundaries.test.ts`.

Run `npm run test --workspace=@allweave/web` for the boundary and theme checks.
The real SDK/faux-provider browser regression lives in
`apps/server/test/workbench-smoke.test.ts`.
