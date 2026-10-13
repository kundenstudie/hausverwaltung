import { listPayments, LIST_CONFIG } from "@/lib/api-data";
import { listRoute } from "@/lib/api-list";

export const GET = listRoute(listPayments, LIST_CONFIG.payments);
