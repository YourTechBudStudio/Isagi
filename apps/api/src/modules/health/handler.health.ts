import { contract } from "@isagi/contract/api";
import { implement } from "@orpc/server";

const os = implement(contract.user.health);

export const ping = os.ping.handler(() => {
  return { status: "ok" };
});
