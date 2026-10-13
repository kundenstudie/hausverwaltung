import { listPropertyTaxes, LIST_CONFIG } from "@/lib/api-data";
import { listRoute } from "@/lib/api-list";

export const GET = listRoute(listPropertyTaxes, LIST_CONFIG.propertyTaxes);
