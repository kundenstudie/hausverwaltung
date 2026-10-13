import { listUnits, LIST_CONFIG } from "@/lib/api-data";
import { listRoute } from "@/lib/api-list";

export const GET = listRoute(listUnits, LIST_CONFIG.units);
