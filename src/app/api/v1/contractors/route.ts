import { listContractors, LIST_CONFIG } from "@/lib/api-data";
import { listRoute } from "@/lib/api-list";

export const GET = listRoute(listContractors, LIST_CONFIG.contractors);
