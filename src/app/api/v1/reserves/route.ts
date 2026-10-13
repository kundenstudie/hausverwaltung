import { listReserves, LIST_CONFIG } from "@/lib/api-data";
import { listRoute } from "@/lib/api-list";

export const GET = listRoute(listReserves, LIST_CONFIG.reserves);
