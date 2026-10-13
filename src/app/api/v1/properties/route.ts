import { listProperties, LIST_CONFIG } from "@/lib/api-data";
import { listRoute } from "@/lib/api-list";

export const GET = listRoute(listProperties, LIST_CONFIG.properties);
