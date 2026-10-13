import { listEconomicPlans, LIST_CONFIG } from "@/lib/api-data";
import { listRoute } from "@/lib/api-list";

export const GET = listRoute(listEconomicPlans, LIST_CONFIG.economicPlans);
