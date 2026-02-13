import { contract } from "@isagi/contract/api";
import { implement } from "@orpc/server";

import { capture } from "./handler.sparks";

const os = implement(contract.user.sparks);

export const router = os.router({
  capture,
});
