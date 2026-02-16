import { healthContract } from "./modules/health";
import { sparksContract } from "./modules/sparks";
import { triageContract } from "./modules/triage";

export const contract = {
  user: {
    health: healthContract,
    sparks: sparksContract,
    triage: triageContract,
  },
};
