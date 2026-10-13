import { listMeters, LIST_CONFIG } from "@/lib/api-data";
import { listRoute } from "@/lib/api-list";

export const GET = listRoute(listMeters, LIST_CONFIG.meters);
