import { DatePicker } from "@tarve/core";

let open = false;
let month = "2026-09";
let date: string | undefined;

<DatePicker
  open={open}
  month={month}
  value={date}
  placeholder="Pick a date"
  onOpenChange={(next) => {
    open = next;
  }}
  onMonthChange={(next) => {
    month = next;
  }}
  onValueChange={(next) => {
    date = next;
    open = false;
  }}
/>;
