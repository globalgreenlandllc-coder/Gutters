"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Hammer,
  MapPin,
  Phone,
  Plus,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  createAppointment,
  deleteAppointment,
  listAppointments,
  listSchedulableItems,
  updateAppointment,
  type AppointmentDTO,
  type SchedulableItem,
} from "@/app/actions/schedule";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Time + grid constants                                             */
/* ------------------------------------------------------------------ */

const DAY_START_HOUR = 6; // 6 AM
const DAY_END_HOUR = 21; // 9 PM
const HOURS_PER_DAY = DAY_END_HOUR - DAY_START_HOUR;
const SLOT_MINUTES = 30;
const SLOTS_PER_HOUR = 60 / SLOT_MINUTES;
const TOTAL_SLOTS = HOURS_PER_DAY * SLOTS_PER_HOUR;
const SLOT_PX = 28; // height of one 30-min slot
const HOUR_PX = SLOT_PX * SLOTS_PER_HOUR;

const TYPE_META: Record<
  AppointmentDTO["type"],
  { label: string; bg: string; ring: string; text: string; chip: string }
> = {
  LEAD_VISIT: {
    label: "Site visit",
    bg: "bg-sky-50",
    ring: "ring-sky-300",
    text: "text-sky-900",
    chip: "bg-sky-500",
  },
  JOB_INSTALL: {
    label: "Install",
    bg: "bg-emerald-50",
    ring: "ring-emerald-300",
    text: "text-emerald-900",
    chip: "bg-emerald-500",
  },
  PROPOSAL_MEETING: {
    label: "Proposal meeting",
    bg: "bg-violet-50",
    ring: "ring-violet-300",
    text: "text-violet-900",
    chip: "bg-violet-500",
  },
  FOLLOW_UP: {
    label: "Follow-up",
    bg: "bg-amber-50",
    ring: "ring-amber-300",
    text: "text-amber-900",
    chip: "bg-amber-500",
  },
  OTHER: {
    label: "Other",
    bg: "bg-zinc-50",
    ring: "ring-zinc-300",
    text: "text-zinc-900",
    chip: "bg-zinc-500",
  },
};

/* ------------------------------------------------------------------ */
/*  Date helpers — local-time week math                               */
/* ------------------------------------------------------------------ */

function startOfWeek(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  // Monday-first; getDay returns 0 for Sun.
  const day = out.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  out.setDate(out.getDate() + diff);
  return out;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

function fmtDay(d: Date): { weekday: string; date: string } {
  return {
    weekday: d.toLocaleDateString(undefined, { weekday: "short" }),
    date: d.toLocaleDateString(undefined, { day: "numeric" }),
  };
}

function fmtRange(start: Date, end: Date): string {
  const opts: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
  };
  const yearOpts: Intl.DateTimeFormatOptions = { ...opts, year: "numeric" };
  const sameYear = start.getFullYear() === end.getFullYear();
  return `${start.toLocaleDateString(undefined, opts)} – ${end.toLocaleDateString(undefined, sameYear ? opts : yearOpts)}, ${end.getFullYear()}`;
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function dateForSlot(weekStart: Date, dayIndex: number, slotIndex: number): Date {
  const out = addDays(weekStart, dayIndex);
  out.setHours(DAY_START_HOUR, 0, 0, 0);
  out.setMinutes(slotIndex * SLOT_MINUTES);
  return out;
}

function minutesFromDayStart(d: Date): number {
  return (d.getHours() - DAY_START_HOUR) * 60 + d.getMinutes();
}

/* ------------------------------------------------------------------ */
/*  Main component                                                    */
/* ------------------------------------------------------------------ */

export function CalendarBoard() {
  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeek(new Date()));
  const [appointments, setAppointments] = useState<AppointmentDTO[]>([]);
  const [schedulable, setSchedulable] = useState<SchedulableItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<AppointmentDTO | null>(null);
  const [creating, setCreating] = useState<{
    startsAt: string;
    endsAt: string;
    seed?: SchedulableItem;
  } | null>(null);
  const [sidebarFilter, setSidebarFilter] = useState("");

  const weekEnd = useMemo(() => addDays(weekStart, 7), [weekStart]);

  const refresh = useCallback(async () => {
    setLoading(true);
    const [appts, items] = await Promise.all([
      listAppointments(weekStart.toISOString(), weekEnd.toISOString()),
      listSchedulableItems(),
    ]);
    setAppointments(appts);
    setSchedulable(items);
    setLoading(false);
  }, [weekStart, weekEnd]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const filteredSidebar = useMemo(() => {
    const q = sidebarFilter.trim().toLowerCase();
    if (!q) return schedulable;
    return schedulable.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        (s.address?.toLowerCase().includes(q) ?? false),
    );
  }, [schedulable, sidebarFilter]);

  /* Drag-and-drop wire-up. We use the native DataTransfer + ref-based
     transfer because (a) it's drop-from-sidebar AND drop-from-another-
     time-slot AND resize, and a single mechanism handles all three;
     (b) no extra deps. dragData carries the payload across handlers. */
  const dragData = useRef<
    | { kind: "item"; item: SchedulableItem }
    | { kind: "appt-move"; appt: AppointmentDTO; grabOffsetMin: number }
    | { kind: "appt-resize"; appt: AppointmentDTO }
    | null
  >(null);

  function startDragItem(e: DragEvent, item: SchedulableItem) {
    dragData.current = { kind: "item", item };
    e.dataTransfer.effectAllowed = "copy";
    // Setting some data is required for Firefox to actually start a drag.
    e.dataTransfer.setData("text/plain", item.id);
  }

  function startDragAppt(e: DragEvent, appt: AppointmentDTO) {
    const grab =
      ((e.clientY -
        (e.currentTarget as HTMLElement).getBoundingClientRect().top) /
        SLOT_PX) *
      SLOT_MINUTES;
    dragData.current = {
      kind: "appt-move",
      appt,
      grabOffsetMin: Math.round(grab / SLOT_MINUTES) * SLOT_MINUTES,
    };
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", appt.id);
  }

  function startResizeAppt(e: DragEvent, appt: AppointmentDTO) {
    dragData.current = { kind: "appt-resize", appt };
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", appt.id);
  }

  /**
   * Resolves a drop event into (dayIndex, slotIndex) coords on the grid,
   * accounting for scroll position. Returns null if dropped outside.
   */
  function dropTarget(
    e: DragEvent,
    container: HTMLElement,
  ): { dayIndex: number; slotIndex: number } | null {
    const rect = container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top + container.scrollTop;
    const dayCol = Math.floor(x / (rect.width / 7));
    const slot = Math.floor(y / SLOT_PX);
    if (dayCol < 0 || dayCol > 6) return null;
    if (slot < 0 || slot >= TOTAL_SLOTS) return null;
    return { dayIndex: dayCol, slotIndex: slot };
  }

  async function onGridDrop(e: DragEvent, container: HTMLElement) {
    e.preventDefault();
    const target = dropTarget(e, container);
    const d = dragData.current;
    dragData.current = null;
    if (!target || !d) return;

    if (d.kind === "item") {
      // New appointment seeded from a lead / proposal — opens the create
      // modal so the user can confirm/tweak before persist.
      const start = dateForSlot(weekStart, target.dayIndex, target.slotIndex);
      const end = new Date(start.getTime() + 60 * 60 * 1000); // 1h default
      setCreating({
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        seed: d.item,
      });
      return;
    }

    if (d.kind === "appt-move") {
      const newStart = dateForSlot(weekStart, target.dayIndex, target.slotIndex);
      newStart.setMinutes(newStart.getMinutes() - d.grabOffsetMin);
      const oldStart = new Date(d.appt.startsAt);
      const oldEnd = new Date(d.appt.endsAt);
      const duration = oldEnd.getTime() - oldStart.getTime();
      const newEnd = new Date(newStart.getTime() + duration);
      // Optimistic UI update — server reconciles on refresh.
      setAppointments((prev) =>
        prev.map((a) =>
          a.id === d.appt.id
            ? { ...a, startsAt: newStart.toISOString(), endsAt: newEnd.toISOString() }
            : a,
        ),
      );
      const r = await updateAppointment(d.appt.id, {
        startsAt: newStart.toISOString(),
        endsAt: newEnd.toISOString(),
      });
      if (!r.ok) refresh();
      return;
    }

    if (d.kind === "appt-resize") {
      // Bottom-edge resize: the drop point becomes the new endsAt.
      const newEnd = dateForSlot(weekStart, target.dayIndex, target.slotIndex);
      newEnd.setMinutes(newEnd.getMinutes() + SLOT_MINUTES); // include the slot we landed in
      const start = new Date(d.appt.startsAt);
      if (newEnd.getTime() <= start.getTime()) return;
      setAppointments((prev) =>
        prev.map((a) =>
          a.id === d.appt.id ? { ...a, endsAt: newEnd.toISOString() } : a,
        ),
      );
      const r = await updateAppointment(d.appt.id, {
        endsAt: newEnd.toISOString(),
      });
      if (!r.ok) refresh();
    }
  }

  return (
    <div className="space-y-4">
      <Header
        weekStart={weekStart}
        weekEnd={addDays(weekStart, 6)}
        onPrev={() => setWeekStart((w) => addDays(w, -7))}
        onNext={() => setWeekStart((w) => addDays(w, 7))}
        onToday={() => setWeekStart(startOfWeek(new Date()))}
        onNew={() => {
          const now = new Date();
          const start = new Date(now);
          start.setMinutes(0, 0, 0);
          if (now.getMinutes() > 0) start.setHours(start.getHours() + 1);
          const end = new Date(start.getTime() + 60 * 60 * 1000);
          setCreating({
            startsAt: start.toISOString(),
            endsAt: end.toISOString(),
          });
        }}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
        <CalendarGrid
          weekStart={weekStart}
          appointments={appointments}
          loading={loading}
          onApptClick={(a) => setEditing(a)}
          onApptDragStart={startDragAppt}
          onApptResizeStart={startResizeAppt}
          onDrop={onGridDrop}
          onEmptyClick={(start, end) =>
            setCreating({
              startsAt: start.toISOString(),
              endsAt: end.toISOString(),
            })
          }
        />

        <Sidebar
          items={filteredSidebar}
          filter={sidebarFilter}
          onFilter={setSidebarFilter}
          onDragStart={startDragItem}
        />
      </div>

      {editing && (
        <EditModal
          appt={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
          onDeleted={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
      {creating && (
        <CreateModal
          startsAt={creating.startsAt}
          endsAt={creating.endsAt}
          seed={creating.seed}
          onClose={() => setCreating(null)}
          onCreated={() => {
            setCreating(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Header bar                                                        */
/* ------------------------------------------------------------------ */

function Header({
  weekStart,
  weekEnd,
  onPrev,
  onNext,
  onToday,
  onNew,
}: {
  weekStart: Date;
  weekEnd: Date;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  onNew: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex items-center gap-2">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent-100 text-accent-700">
          <CalendarDays className="h-4 w-4" />
        </div>
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-zinc-900">
            Schedule
          </h1>
          <p className="text-xs text-zinc-500">
            Drag leads + proposals onto the week to book site visits and installs.
          </p>
        </div>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <div className="hidden text-sm font-medium text-zinc-700 sm:block">
          {fmtRange(weekStart, weekEnd)}
        </div>
        <div className="flex items-center rounded-lg border border-zinc-200 bg-white shadow-sm">
          <button
            onClick={onPrev}
            className="flex h-9 w-9 items-center justify-center rounded-l-lg text-zinc-500 transition hover:bg-zinc-50 hover:text-zinc-900"
            aria-label="Previous week"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            onClick={onToday}
            className="border-x border-zinc-200 px-3 text-xs font-medium text-zinc-700 transition hover:bg-zinc-50"
          >
            Today
          </button>
          <button
            onClick={onNext}
            className="flex h-9 w-9 items-center justify-center rounded-r-lg text-zinc-500 transition hover:bg-zinc-50 hover:text-zinc-900"
            aria-label="Next week"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <button
          onClick={onNew}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-accent-600 px-3 text-xs font-semibold text-white shadow-sm transition hover:bg-accent-700"
        >
          <Plus className="h-4 w-4" />
          New appointment
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Week grid + event tiles                                           */
/* ------------------------------------------------------------------ */

function CalendarGrid({
  weekStart,
  appointments,
  loading,
  onApptClick,
  onApptDragStart,
  onApptResizeStart,
  onDrop,
  onEmptyClick,
}: {
  weekStart: Date;
  appointments: AppointmentDTO[];
  loading: boolean;
  onApptClick: (a: AppointmentDTO) => void;
  onApptDragStart: (e: DragEvent, a: AppointmentDTO) => void;
  onApptResizeStart: (e: DragEvent, a: AppointmentDTO) => void;
  onDrop: (e: DragEvent, container: HTMLElement) => void;
  onEmptyClick: (start: Date, end: Date) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );
  const today = new Date();

  // Bucket appointments by day index (0-6 across visible week).
  const apptsByDay = useMemo(() => {
    const map: Record<number, AppointmentDTO[]> = {};
    for (let i = 0; i < 7; i++) map[i] = [];
    for (const a of appointments) {
      const startsAt = new Date(a.startsAt);
      for (let i = 0; i < 7; i++) {
        if (sameDay(startsAt, days[i])) {
          map[i].push(a);
          break;
        }
      }
    }
    return map;
  }, [appointments, days]);

  // Current-time indicator (red line). Only show when "today" is in view.
  const todayIndex = days.findIndex((d) => sameDay(d, today));
  const nowOffset =
    todayIndex >= 0
      ? Math.max(0, Math.min(TOTAL_SLOTS * SLOT_PX, (minutesFromDayStart(today) / 60) * HOUR_PX))
      : null;

  return (
    <div className="surface overflow-hidden shadow-card">
      {/* Day header row */}
      <div className="grid grid-cols-[60px_repeat(7,1fr)] border-b border-zinc-200 bg-zinc-50/60">
        <div />
        {days.map((d, i) => {
          const f = fmtDay(d);
          const isToday = sameDay(d, today);
          return (
            <div
              key={i}
              className={cn(
                "border-l border-zinc-200 px-2 py-2 text-center",
                isToday && "bg-accent-50",
              )}
            >
              <div className="font-label text-[10px] text-zinc-500">
                {f.weekday}
              </div>
              <div
                className={cn(
                  "mt-0.5 text-lg font-semibold tabular-nums",
                  isToday ? "text-accent-700" : "text-zinc-900",
                )}
              >
                {f.date}
              </div>
            </div>
          );
        })}
      </div>

      {/* Grid body — scrollable for the time column */}
      <div
        ref={containerRef}
        className="relative max-h-[70vh] overflow-y-auto"
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }}
        onDrop={(e) => containerRef.current && onDrop(e, containerRef.current)}
      >
        <div
          className="relative grid grid-cols-[60px_repeat(7,1fr)]"
          style={{ height: TOTAL_SLOTS * SLOT_PX }}
        >
          {/* Time column */}
          <div className="relative">
            {Array.from({ length: HOURS_PER_DAY }, (_, i) => (
              <div
                key={i}
                className="font-label border-t border-zinc-100 pl-2 text-[10px] text-zinc-400"
                style={{ height: HOUR_PX }}
              >
                {((DAY_START_HOUR + i) % 12 || 12) +
                  (DAY_START_HOUR + i < 12 ? " AM" : " PM")}
              </div>
            ))}
          </div>

          {/* Day columns */}
          {days.map((d, dayIdx) => (
            <div
              key={dayIdx}
              className="relative border-l border-zinc-100"
            >
              {/* Hour grid lines */}
              {Array.from({ length: HOURS_PER_DAY }, (_, i) => (
                <div
                  key={i}
                  className="border-t border-zinc-100"
                  style={{ height: HOUR_PX }}
                />
              ))}
              {/* Half-hour clickable slots (transparent) */}
              {Array.from({ length: TOTAL_SLOTS }, (_, slotIdx) => (
                <button
                  key={slotIdx}
                  type="button"
                  className="absolute inset-x-0 hover:bg-accent-50/40"
                  style={{ top: slotIdx * SLOT_PX, height: SLOT_PX }}
                  onClick={() => {
                    const s = dateForSlot(weekStart, dayIdx, slotIdx);
                    const e = new Date(s.getTime() + 60 * 60 * 1000);
                    onEmptyClick(s, e);
                  }}
                />
              ))}
              {/* Today highlight overlay */}
              {sameDay(d, today) && (
                <div className="pointer-events-none absolute inset-0 bg-accent-50/30" />
              )}
              {/* Event tiles */}
              {apptsByDay[dayIdx].map((a) => (
                <EventTile
                  key={a.id}
                  appt={a}
                  onClick={() => onApptClick(a)}
                  onDragStart={(e) => onApptDragStart(e, a)}
                  onResizeStart={(e) => onApptResizeStart(e, a)}
                />
              ))}
            </div>
          ))}

          {/* "Now" line */}
          {nowOffset !== null && (
            <div
              className="pointer-events-none absolute left-[60px] right-0 z-10"
              style={{ top: nowOffset }}
            >
              <div className="relative">
                <div
                  className="absolute h-0.5 w-full bg-rose-500"
                  style={{
                    left: `calc(${todayIndex} * ((100% - 0px) / 7))`,
                    width: `calc((100% - 0px) / 7)`,
                  }}
                />
                <div
                  className="absolute -top-1 h-2.5 w-2.5 -translate-x-1/2 rounded-full bg-rose-500 ring-2 ring-white"
                  style={{ left: `calc(${todayIndex} * ((100% - 0px) / 7))` }}
                />
              </div>
            </div>
          )}
        </div>

        {loading && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-white/40 text-xs text-zinc-500">
            Loading…
          </div>
        )}
      </div>
    </div>
  );
}

function EventTile({
  appt,
  onClick,
  onDragStart,
  onResizeStart,
}: {
  appt: AppointmentDTO;
  onClick: () => void;
  onDragStart: (e: DragEvent) => void;
  onResizeStart: (e: DragEvent) => void;
}) {
  const start = new Date(appt.startsAt);
  const end = new Date(appt.endsAt);
  const topMin = minutesFromDayStart(start);
  const durMin = Math.max(SLOT_MINUTES, (end.getTime() - start.getTime()) / 60000);
  const meta = TYPE_META[appt.type];

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onClick={onClick}
      className={cn(
        "group absolute inset-x-1 cursor-grab overflow-hidden rounded-md ring-1 active:cursor-grabbing",
        meta.bg,
        meta.ring,
        appt.status === "CANCELLED" && "opacity-40 line-through",
      )}
      style={{
        top: (topMin / 60) * HOUR_PX,
        height: Math.max((durMin / 60) * HOUR_PX - 2, SLOT_PX - 2),
        backgroundColor: appt.colorHex ?? undefined,
      }}
    >
      {/* Left type-color bar */}
      <span
        className={cn("absolute inset-y-0 left-0 w-[3px]", meta.chip)}
        aria-hidden
      />
      <div className="flex items-center gap-1 pl-3 pr-2 pt-1">
        <span
          className={cn(
            "truncate text-[11px] font-semibold",
            meta.text,
          )}
        >
          {appt.title}
        </span>
      </div>
      <div
        className={cn("truncate pl-3 pr-2 pb-1 text-[10px] opacity-80", meta.text)}
      >
        {fmtTime(start)} – {fmtTime(end)}
        {appt.address ? ` · ${appt.address.split(",")[0]}` : ""}
      </div>
      {/* Bottom resize handle */}
      <div
        draggable
        onDragStart={(e) => {
          e.stopPropagation();
          onResizeStart(e);
        }}
        className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize bg-transparent group-hover:bg-zinc-900/10"
        title="Drag to resize"
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Sidebar — schedulable items                                       */
/* ------------------------------------------------------------------ */

function Sidebar({
  items,
  filter,
  onFilter,
  onDragStart,
}: {
  items: SchedulableItem[];
  filter: string;
  onFilter: (v: string) => void;
  onDragStart: (e: DragEvent, item: SchedulableItem) => void;
}) {
  const leads = items.filter((i) => i.kind === "lead");
  const proposals = items.filter((i) => i.kind === "proposal");

  return (
    <aside className="surface space-y-3 p-3 shadow-card">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-accent-600" />
        <h2 className="text-sm font-semibold text-zinc-900">Drag onto week</h2>
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
        <input
          value={filter}
          onChange={(e) => onFilter(e.target.value)}
          placeholder="Filter…"
          className="input h-8 pl-8 pr-2 text-xs"
        />
      </div>
      {items.length === 0 ? (
        <p className="rounded-lg bg-zinc-50 p-3 text-xs text-zinc-500">
          Nothing here yet. Visit a lead or save a draft proposal and it'll show up
          to drag onto your week.
        </p>
      ) : (
        <div className="max-h-[60vh] space-y-3 overflow-y-auto">
          {leads.length > 0 && (
            <Group title="Leads to visit" count={leads.length}>
              {leads.map((i) => (
                <DragItem key={i.id} item={i} onDragStart={onDragStart} />
              ))}
            </Group>
          )}
          {proposals.length > 0 && (
            <Group title="Proposals to install" count={proposals.length}>
              {proposals.map((i) => (
                <DragItem key={i.id} item={i} onDragStart={onDragStart} />
              ))}
            </Group>
          )}
        </div>
      )}
    </aside>
  );
}

function Group({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="font-label mb-1.5 flex items-center justify-between px-1 text-[10px] text-zinc-500">
        <span>{title}</span>
        <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-600">
          {count}
        </span>
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function DragItem({
  item,
  onDragStart,
}: {
  item: SchedulableItem;
  onDragStart: (e: DragEvent, item: SchedulableItem) => void;
}) {
  const color =
    item.kind === "lead"
      ? "border-sky-200 bg-sky-50 hover:bg-sky-100"
      : "border-emerald-200 bg-emerald-50 hover:bg-emerald-100";
  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, item)}
      className={cn(
        "group cursor-grab rounded-lg border px-2.5 py-1.5 text-xs shadow-sm transition active:cursor-grabbing",
        color,
      )}
      title="Drag onto the calendar"
    >
      <div className="flex items-center gap-1.5">
        {item.kind === "lead" ? (
          <MapPin className="h-3 w-3 text-sky-700" />
        ) : (
          <Hammer className="h-3 w-3 text-emerald-700" />
        )}
        <span className="truncate font-medium text-zinc-900">{item.title}</span>
      </div>
      {item.address && (
        <div className="truncate text-[11px] text-zinc-500">{item.address}</div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Modals — create + edit                                            */
/* ------------------------------------------------------------------ */

function CreateModal({
  startsAt,
  endsAt,
  seed,
  onClose,
  onCreated,
}: {
  startsAt: string;
  endsAt: string;
  seed?: SchedulableItem;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState(seed?.title ?? "");
  const [address, setAddress] = useState(seed?.address ?? "");
  const [clientName, setClientName] = useState(seed?.clientName ?? "");
  const [clientPhone, setClientPhone] = useState("");
  const [clientEmail, setClientEmail] = useState(seed?.clientEmail ?? "");
  const [type, setType] = useState<AppointmentDTO["type"]>(
    seed?.kind === "lead"
      ? "LEAD_VISIT"
      : seed?.kind === "proposal"
        ? "JOB_INSTALL"
        : "OTHER",
  );
  const [start, setStart] = useState(toLocalInput(startsAt));
  const [end, setEnd] = useState(toLocalInput(endsAt));
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onSave() {
    if (!title.trim()) {
      setErr("Title is required");
      return;
    }
    setSaving(true);
    setErr(null);
    const r = await createAppointment({
      title,
      type,
      startsAt: fromLocalInput(start),
      endsAt: fromLocalInput(end),
      address: address || null,
      notes: notes || null,
      clientName: clientName || null,
      clientPhone: clientPhone || null,
      clientEmail: clientEmail || null,
      leadId: seed?.kind === "lead" ? seed.id : null,
      proposalId: seed?.kind === "proposal" ? seed.id : null,
    });
    setSaving(false);
    if (!r.ok) {
      setErr(r.reason);
      return;
    }
    onCreated();
  }

  return (
    <ModalShell onClose={onClose} title="New appointment">
      <Form
        title={title}
        setTitle={setTitle}
        type={type}
        setType={setType}
        start={start}
        setStart={setStart}
        end={end}
        setEnd={setEnd}
        address={address}
        setAddress={setAddress}
        clientName={clientName}
        setClientName={setClientName}
        clientPhone={clientPhone}
        setClientPhone={setClientPhone}
        clientEmail={clientEmail}
        setClientEmail={setClientEmail}
        notes={notes}
        setNotes={setNotes}
      />
      {err && (
        <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {err}
        </p>
      )}
      <div className="flex items-center justify-end gap-2 pt-2">
        <button
          onClick={onClose}
          className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50"
        >
          Cancel
        </button>
        <button
          onClick={onSave}
          disabled={saving}
          className="inline-flex items-center gap-1.5 rounded-lg bg-accent-600 px-4 py-1.5 text-sm font-semibold text-white shadow-sm transition hover:bg-accent-700 disabled:opacity-60"
        >
          {saving ? "Saving…" : "Schedule"}
        </button>
      </div>
    </ModalShell>
  );
}

function EditModal({
  appt,
  onClose,
  onSaved,
  onDeleted,
}: {
  appt: AppointmentDTO;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const [title, setTitle] = useState(appt.title);
  const [type, setType] = useState<AppointmentDTO["type"]>(appt.type);
  const [start, setStart] = useState(toLocalInput(appt.startsAt));
  const [end, setEnd] = useState(toLocalInput(appt.endsAt));
  const [address, setAddress] = useState(appt.address ?? "");
  const [clientName, setClientName] = useState(appt.clientName ?? "");
  const [clientPhone, setClientPhone] = useState(appt.clientPhone ?? "");
  const [clientEmail, setClientEmail] = useState(appt.clientEmail ?? "");
  const [notes, setNotes] = useState(appt.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onSave() {
    setSaving(true);
    setErr(null);
    const r = await updateAppointment(appt.id, {
      title,
      type,
      startsAt: fromLocalInput(start),
      endsAt: fromLocalInput(end),
      address,
      notes,
      clientName,
      clientPhone,
      clientEmail,
    });
    setSaving(false);
    if (!r.ok) {
      setErr(r.reason);
      return;
    }
    onSaved();
  }

  async function onDelete() {
    if (!confirm("Delete this appointment?")) return;
    setSaving(true);
    const r = await deleteAppointment(appt.id);
    setSaving(false);
    if (!r.ok) {
      setErr(r.reason);
      return;
    }
    onDeleted();
  }

  return (
    <ModalShell onClose={onClose} title="Edit appointment">
      <Form
        title={title}
        setTitle={setTitle}
        type={type}
        setType={setType}
        start={start}
        setStart={setStart}
        end={end}
        setEnd={setEnd}
        address={address}
        setAddress={setAddress}
        clientName={clientName}
        setClientName={setClientName}
        clientPhone={clientPhone}
        setClientPhone={setClientPhone}
        clientEmail={clientEmail}
        setClientEmail={setClientEmail}
        notes={notes}
        setNotes={setNotes}
      />
      {err && (
        <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {err}
        </p>
      )}
      <div className="flex items-center justify-between gap-2 pt-2">
        <button
          onClick={onDelete}
          className="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-white px-3 py-1.5 text-sm font-medium text-rose-700 transition hover:bg-rose-50"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete
        </button>
        <div className="flex items-center gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50"
          >
            Cancel
          </button>
          <button
            onClick={onSave}
            disabled={saving}
            className="rounded-lg bg-accent-600 px-4 py-1.5 text-sm font-semibold text-white shadow-sm transition hover:bg-accent-700 disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function ModalShell({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-zinc-900/40 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="surface relative z-10 w-full max-w-lg space-y-3 p-5 shadow-elevated">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight text-zinc-900">
            {title}
          </h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-900"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Form(props: {
  title: string;
  setTitle: (v: string) => void;
  type: AppointmentDTO["type"];
  setType: (v: AppointmentDTO["type"]) => void;
  start: string;
  setStart: (v: string) => void;
  end: string;
  setEnd: (v: string) => void;
  address: string;
  setAddress: (v: string) => void;
  clientName: string;
  setClientName: (v: string) => void;
  clientPhone: string;
  setClientPhone: (v: string) => void;
  clientEmail: string;
  setClientEmail: (v: string) => void;
  notes: string;
  setNotes: (v: string) => void;
}) {
  return (
    <div className="space-y-3">
      <div>
        <Label>Title</Label>
        <input
          value={props.title}
          onChange={(e) => props.setTitle(e.target.value)}
          placeholder="Site visit, gutter install, …"
          className={inputCls}
        />
      </div>
      <div>
        <Label>Type</Label>
        <div className="flex flex-wrap gap-1.5">
          {(Object.entries(TYPE_META) as [
            AppointmentDTO["type"],
            (typeof TYPE_META)[AppointmentDTO["type"]],
          ][]).map(([k, m]) => (
            <button
              key={k}
              type="button"
              onClick={() => props.setType(k)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition",
                props.type === k
                  ? "border-accent-500 bg-accent-50 text-accent-900"
                  : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50",
              )}
            >
              <span className={cn("h-1.5 w-1.5 rounded-full", m.chip)} />
              {m.label}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label>Start</Label>
          <input
            type="datetime-local"
            value={props.start}
            onChange={(e) => props.setStart(e.target.value)}
            className={inputCls}
          />
        </div>
        <div>
          <Label>End</Label>
          <input
            type="datetime-local"
            value={props.end}
            onChange={(e) => props.setEnd(e.target.value)}
            className={inputCls}
          />
        </div>
      </div>
      <div>
        <Label>Address</Label>
        <div className="relative">
          <MapPin className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
          <input
            value={props.address}
            onChange={(e) => props.setAddress(e.target.value)}
            placeholder="1247 Maple Ridge Drive…"
            className={cn(inputCls, "pl-8")}
          />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div>
          <Label>Client</Label>
          <input
            value={props.clientName}
            onChange={(e) => props.setClientName(e.target.value)}
            placeholder="Name"
            className={inputCls}
          />
        </div>
        <div>
          <Label>Phone</Label>
          <div className="relative">
            <Phone className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <input
              value={props.clientPhone}
              onChange={(e) => props.setClientPhone(e.target.value)}
              placeholder="(555) 123-4567"
              className={cn(inputCls, "pl-8")}
            />
          </div>
        </div>
        <div>
          <Label>Email</Label>
          <input
            value={props.clientEmail}
            onChange={(e) => props.setClientEmail(e.target.value)}
            placeholder="name@…"
            className={inputCls}
          />
        </div>
      </div>
      <div>
        <Label>Notes</Label>
        <textarea
          value={props.notes}
          onChange={(e) => props.setNotes(e.target.value)}
          rows={2}
          placeholder="Bring extension ladder, gate code 4321…"
          className={cn(inputCls, "min-h-[3rem] resize-y")}
        />
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-label mb-1 text-[10px] text-zinc-500">
      {children}
    </div>
  );
}

const inputCls = "input";

/* ------------------------------------------------------------------ */
/*  datetime-local <-> ISO helpers                                    */
/* ------------------------------------------------------------------ */

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(local: string): string {
  // datetime-local has no timezone; treat as local time.
  return new Date(local).toISOString();
}
