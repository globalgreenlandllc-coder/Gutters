"use client";

import { AuthGate } from "@/components/auth/auth-gate";
import { DashboardShell } from "@/components/dashboard/dashboard-nav";
import { CalendarBoard } from "@/components/calendar/calendar-board";

export default function CalendarPage() {
  return (
    <AuthGate>
      <DashboardShell title="Calendar" contentClassName="max-w-[1600px]">
        <CalendarBoard />
      </DashboardShell>
    </AuthGate>
  );
}
