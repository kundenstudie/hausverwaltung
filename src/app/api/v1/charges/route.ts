import { listCharges, LIST_CONFIG } from "@/lib/api-data";
import { listRoute } from "@/lib/api-list";

export const GET = listRoute(listCharges, LIST_CONFIG.charges);
