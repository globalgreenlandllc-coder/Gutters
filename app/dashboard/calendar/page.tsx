"use client";

import { AuthGate } from "@/components/auth/auth-gate";
import { DashboardNav } from "@/components/dashboard/dashboard-nav";
import { CalendarBoard } from "@/components/calendar/calendar-board";

export default function CalendarPage() {
  return (
    <AuthGate>
      <DashboardNav />
      <main className="mx-auto w-full max-w-[1600px] px-4 pb-12 pt-6 sm:px-6">
        <CalendarBoard />
      </main>
    </AuthGate>
  );
}
