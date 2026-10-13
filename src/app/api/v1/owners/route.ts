import { listOwners, LIST_CONFIG } from "@/lib/api-data";
import { listRoute } from "@/lib/api-list";

export const GET = listRoute(listOwners, LIST_CONFIG.owners);
