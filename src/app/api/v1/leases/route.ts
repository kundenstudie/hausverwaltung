import { listLeases, LIST_CONFIG } from "@/lib/api-data";
import { listRoute } from "@/lib/api-list";

export const GET = listRoute(listLeases, LIST_CONFIG.leases);
