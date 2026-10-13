import { listInsurances, LIST_CONFIG } from "@/lib/api-data";
import { listRoute } from "@/lib/api-list";

export const GET = listRoute(listInsurances, LIST_CONFIG.insurances);
