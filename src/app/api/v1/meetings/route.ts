import { listMeetings, LIST_CONFIG } from "@/lib/api-data";
import { listRoute } from "@/lib/api-list";

export const GET = listRoute(listMeetings, LIST_CONFIG.meetings);
