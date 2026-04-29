import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import { DayPicker } from "react-day-picker"

import { cn } from "@/lib/utils"

export type CalendarProps = React.ComponentProps<typeof DayPicker>

export function Calendar({ className, classNames, ...props }: CalendarProps) {
  return (
    <DayPicker
      showOutsideDays
      className={cn("p-0", className)}
      classNames={{
        months: "flex",
        month: "space-y-3",
        caption: "flex items-center justify-between px-1 pt-0",
        caption_label: "text-sm font-medium",
        nav: "flex items-center gap-1",
        nav_button:
          "inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground",
        table: "w-full border-collapse",
        head_row: "flex",
        head_cell: "w-9 text-[10px] font-normal uppercase tracking-wide text-muted-foreground",
        row: "mt-1 flex w-full",
        cell: "relative h-9 w-9 p-0 text-center text-sm",
        day: "inline-flex h-9 w-9 items-center justify-center rounded-md text-sm hover:bg-muted",
        day_today: "font-semibold text-primary",
        day_selected: "bg-primary text-primary-foreground hover:bg-primary",
        day_outside: "text-muted-foreground/40",
        day_disabled: "text-muted-foreground/40",
        ...classNames,
      }}
      components={{
        IconLeft: () => <ChevronLeftIcon className="h-4 w-4" />,
        IconRight: () => <ChevronRightIcon className="h-4 w-4" />,
      }}
      {...props}
    />
  )
}
