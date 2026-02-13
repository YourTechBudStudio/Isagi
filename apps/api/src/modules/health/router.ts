import { contract } from "@isagi/contract/api";
import { implement } from "@orpc/server";

import { ping } from "./handler.health";

const os = implement(contract.user.health);

export const router = os.router({
  ping,
});
