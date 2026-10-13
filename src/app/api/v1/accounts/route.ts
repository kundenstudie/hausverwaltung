import { listAccounts, LIST_CONFIG } from "@/lib/api-data";
import { listRoute } from "@/lib/api-list";

export const GET = listRoute(listAccounts, LIST_CONFIG.accounts);
