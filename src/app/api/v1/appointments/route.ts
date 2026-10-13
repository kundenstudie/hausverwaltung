import { listAppointments, LIST_CONFIG } from "@/lib/api-data";
import { listRoute } from "@/lib/api-list";

export const GET = listRoute(listAppointments, LIST_CONFIG.appointments);
