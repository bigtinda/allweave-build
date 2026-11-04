import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const allweaveMessagesApi = (): ProviderStreams => lazyApi(() => import("./allweave-messages.ts"));
