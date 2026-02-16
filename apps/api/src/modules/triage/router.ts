import { contract } from "@isagi/contract/api";
import { implement } from "@orpc/server";

import { apply, list, messages, send, state } from "./handler.triage";

const os = implement(contract.user.triage);

export const router = os.router({
  list,
  state,
  messages,
  send,
  apply,
});
