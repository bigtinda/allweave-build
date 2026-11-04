import type { NativeModelRuntime } from "@pi-console/kernel-adapters";
import type { Harness } from "../../../packages/coding-agent/test/suite/harness.ts";

/** Adapt the faux-provider harness to the native model gateway for server tests. */
export function nativeGateway(harness: Harness): NativeModelRuntime {
	return {
		getModel: (provider, id) => harness.session.modelRuntime.getModel(provider, id),
		getModels: () => [harness.getModel()],
		streamSimple: (model, context, options) => harness.session.modelRuntime.streamSimple(model, context, options),
	};
}
