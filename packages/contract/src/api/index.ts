import { healthContract } from "./modules/health";
import { sparksContract } from "./modules/sparks";

export const contract = {
  user: {
    health: healthContract,
    sparks: sparksContract,
  },
};
