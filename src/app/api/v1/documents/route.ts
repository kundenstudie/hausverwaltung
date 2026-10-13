import { listDocuments, LIST_CONFIG } from "@/lib/api-data";
import { listRoute } from "@/lib/api-list";

export const GET = listRoute(listDocuments, LIST_CONFIG.documents);
