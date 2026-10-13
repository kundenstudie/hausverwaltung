import { listOpenItems, LIST_CONFIG } from "@/lib/api-data";
import { listRoute } from "@/lib/api-list";

export const GET = listRoute(listOpenItems, LIST_CONFIG.openItems);
