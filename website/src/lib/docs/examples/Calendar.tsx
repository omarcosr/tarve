import { Calendar } from "@tarve/core";

let month = "2026-09";
let date = "2026-09-22";

<Calendar
  month={month}
  value={date}
  weekStartsOn={1}
  isDateDisabled={(day) => new Date(day).getDay() === 0}
  onMonthChange={(next) => {
    month = next;
  }}
  onValueChange={(next) => {
    date = next;
  }}
/>;
