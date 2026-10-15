/**
 * Intl for txiki.js: QuickJS-ng has none. Numbers and the common date and time
 * formats follow ICU (as Bun and Node format them) for the locales in intl-data.ts,
 * generated from ICU by scripts/generate-txiki-intl.ts. Other locales use the
 * closest one (same language, else en-US); unusual date option sets fall back to
 * an en-US style composition.
 */
import { dlopen } from "tjs:ffi";
import { DATE_KEYS, LOCALES, NAMES, TEMPLATES, type LocaleData } from "./intl-data";

declare const TARVE_TXIKI_PLATFORM: "win32" | "linux";

let systemLocale: string | undefined;
function defaultLocale(): string {
  if (systemLocale) return systemLocale;
  let found: string | undefined;
  try {
    if (TARVE_TXIKI_PLATFORM === "win32") {
      const buffer = new Uint8Array(85 * 2);
      const length = dlopen("kernel32.dll", { GetUserDefaultLocaleName: { args: ["buffer", "i32"], returns: "i32" } }).symbols.GetUserDefaultLocaleName(buffer, 85);
      if (length > 1) found = String.fromCharCode(...new Uint16Array(buffer.buffer, 0, length - 1));
    } else {
      found = (tjs.env.LC_ALL || tjs.env.LC_NUMERIC || tjs.env.LANG || "").split(".")[0];
    }
  } catch { /* en-US */ }
  return systemLocale = resolveLocale(found || "en-US");
}

const LOCALE_NAMES = Object.keys(LOCALES);
function resolveLocale(requested: string | readonly string[] | undefined): string {
  const list = requested === undefined ? [] : typeof requested === "string" ? [requested] : requested;
  for (const item of list) {
    const tag = String(item).replace(/_/g, "-").toLowerCase();
    const exact = LOCALE_NAMES.find(name => name.toLowerCase() === tag);
    if (exact) return exact;
    const language = LOCALE_NAMES.find(name => name.split("-")[0]!.toLowerCase() === tag.split("-")[0]);
    if (language) return language;
  }
  return list.length ? "en-US" : defaultLocale();
}

interface NumberOptions {
  style?: "decimal" | "percent" | "unit" | "currency";
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
  useGrouping?: boolean;
  unit?: string;
  currency?: string;
}

function groupDigits(whole: string, data: LocaleData): string {
  const [group, , minGroup, secondary] = data;
  if (!group || whole.length < 3 + minGroup) return whole;
  let out = whole.slice(-3);
  let rest = whole.slice(0, -3);
  while (rest.length > secondary) {
    out = rest.slice(-secondary) + group + out;
    rest = rest.slice(0, -secondary);
  }
  return rest ? rest + group + out : out;
}

class NumberFormat {
  private readonly locale: string;
  private readonly data: LocaleData;

  constructor(locales?: string | string[], private readonly options: NumberOptions = {}) {
    this.locale = resolveLocale(locales);
    this.data = LOCALES[this.locale]!;
  }

  format(input: number | bigint): string {
    let value = Number(input);
    const o = this.options;
    const [, decimal, , , percent, minus] = this.data;
    if (Number.isNaN(value)) return "NaN";
    if (o.style === "percent") value *= 100;
    const maximum = o.maximumFractionDigits ?? Math.max(o.minimumFractionDigits ?? 0, o.style === "percent" ? 0 : o.style === "currency" ? 2 : 3);
    const minimum = Math.min(o.minimumFractionDigits ?? (o.style === "currency" ? 2 : 0), maximum);
    let digits: string;
    if (!Number.isFinite(value)) digits = "∞";
    else {
      let [whole, fraction = ""] = Math.abs(value).toFixed(maximum).split(".") as [string, string?];
      while (fraction.length > minimum && fraction.endsWith("0")) fraction = fraction.slice(0, -1);
      if (o.useGrouping !== false) whole = groupDigits(whole, this.data);
      digits = fraction ? whole + decimal + fraction : whole;
    }
    // ICU keeps the sign of a negative value that rounds to zero ("-0").
    const negative = value < 0 || Object.is(value, -0);
    const sign = negative ? minus : "";
    if (o.style === "percent") return sign + percent.replace("{n}", digits);
    if (o.style === "currency") return `${sign}${o.currency === "USD" || !o.currency ? "$" : `${o.currency} `}${digits}`;
    if (o.style === "unit" && o.unit) return `${sign}${digits} ${o.unit}`;
    return sign + digits;
  }

  formatToParts(input: number | bigint) {
    return [{ type: "literal", value: this.format(input) }];
  }

  resolvedOptions() {
    return { locale: this.locale, numberingSystem: "latn", ...this.options };
  }

  static supportedLocalesOf(locales: string | string[]): string[] {
    return (typeof locales === "string" ? [locales] : locales).filter(locale => LOCALE_NAMES.includes(resolveLocale(locale)));
  }
}

type Width = "numeric" | "2-digit" | "short" | "long" | "narrow";
interface DateTimeOptions {
  weekday?: Width; era?: Width; year?: Width; month?: Width; day?: Width;
  hour?: Width; minute?: Width; second?: Width; hour12?: boolean; timeZone?: string;
  dateStyle?: "full" | "long" | "medium" | "short"; timeStyle?: "full" | "long" | "medium" | "short";
}
const DATE_FIELDS = ["weekday", "year", "month", "day", "hour", "minute", "second", "hour12", "dateStyle", "timeStyle"] as const;

function dateKey(options: DateTimeOptions): string {
  const picked: Record<string, unknown> = {};
  for (const field of DATE_FIELDS) {
    let value = options[field];
    // ICU always pads minutes and seconds.
    if ((field === "minute" || field === "second") && value === "numeric") value = "2-digit";
    if (value !== undefined) picked[field] = value;
  }
  return Object.keys(picked).sort().map(key => key + "=" + String(picked[key])).join(",");
}

const pad2 = (value: number) => String(value).padStart(2, "0");
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

class DateTimeFormat {
  private readonly locale: string;
  private readonly options: DateTimeOptions;
  private readonly entry: number[] | undefined;

  constructor(locales?: string | string[], options: DateTimeOptions = {}) {
    this.locale = resolveLocale(locales);
    this.options = { ...options };
    const index = DATE_KEYS.indexOf(dateKey(options));
    this.entry = index >= 0 ? LOCALES[this.locale]![6][index] : undefined;
  }

  format(value: Date | number = Date.now()): string {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "Invalid Date";
    const utc = this.options.timeZone === "UTC";
    const fields = {
      year: utc ? date.getUTCFullYear() : date.getFullYear(), month: utc ? date.getUTCMonth() : date.getMonth(),
      day: utc ? date.getUTCDate() : date.getDate(), weekday: utc ? date.getUTCDay() : date.getDay(),
      hour: utc ? date.getUTCHours() : date.getHours(), minute: utc ? date.getUTCMinutes() : date.getMinutes(), second: utc ? date.getUTCSeconds() : date.getSeconds(),
    };
    if (!this.entry) return this.fallback(fields);
    const [template, months, weekdays, periods] = this.entry as [number, number, number, number];
    const source = TEMPLATES[template]!;
    const cycle = Number(/\{c(\d+)\}/.exec(source)?.[1] ?? 23);
    return source.replace(/\{([wMdyhmsaGc])(\d+)\}/g, (_, token: string, flag: string) => {
      const padded = flag === "1";
      switch (token) {
        case "w": return NAMES[weekdays]![fields.weekday]!;
        case "M": return months >= 0 ? NAMES[months]![fields.month]! : padded ? pad2(fields.month + 1) : String(fields.month + 1);
        case "d": return padded ? pad2(fields.day) : String(fields.day);
        case "y": return padded ? pad2(fields.year % 100) : String(fields.year);
        case "h": {
          const hour = cycle === 23 ? fields.hour : cycle === 24 ? fields.hour || 24 : cycle === 11 ? fields.hour % 12 : fields.hour % 12 || 12;
          return padded ? pad2(hour) : String(hour);
        }
        case "m": return pad2(fields.minute);
        case "s": return pad2(fields.second);
        case "a": return NAMES[periods]![fields.hour]!;
        default: return "";
      }
    });
  }

  /** en-US composition for option sets intl-data.ts does not carry. */
  private fallback(f: { year: number; month: number; day: number; weekday: number; hour: number; minute: number; second: number }): string {
    const o = this.options;
    const name = (names: string[], index: number, width?: Width) => width === "long" ? names[index]! : width === "narrow" ? names[index]![0]! : names[index]!.slice(0, 3);
    const any = o.weekday || o.year || o.month || o.day || o.hour || o.minute || o.second;
    const d = any ? o : { year: "numeric", month: "numeric", day: "numeric" } as DateTimeOptions;
    const numeric = d.month === "numeric" || d.month === "2-digit";
    const day = numeric
      ? [d.month && String(f.month + 1), d.day && String(f.day), d.year && String(f.year)].filter(Boolean).join("/")
      : [[d.month && name(MONTHS, f.month, d.month), d.day && String(f.day)].filter(Boolean).join(" "), d.year && String(f.year)].filter(Boolean).join(", ");
    let time = "";
    if (d.hour || d.minute || d.second) {
      const twelve = d.hour12 ?? true;
      time = [d.hour && String(twelve ? f.hour % 12 || 12 : f.hour), d.minute && pad2(f.minute), d.second && pad2(f.second)].filter(Boolean).join(":");
      if (twelve && d.hour) time += f.hour < 12 ? " AM" : " PM";
    }
    return [[d.weekday ? name(WEEKDAYS, f.weekday, d.weekday) : "", day].filter(Boolean).join(", "), time].filter(Boolean).join(", ");
  }

  formatToParts(value?: Date | number) {
    return [{ type: "literal", value: this.format(value) }];
  }

  resolvedOptions() {
    return { locale: this.locale, calendar: "gregory", numberingSystem: "latn", timeZone: this.options.timeZone ?? "UTC", ...this.options };
  }

  static supportedLocalesOf(locales: string | string[]): string[] {
    return NumberFormat.supportedLocalesOf(locales);
  }
}

class Collator {
  constructor(_locales?: string | string[], private readonly options: { numeric?: boolean; sensitivity?: string } = {}) {}

  compare = (left: string, right: string): number => {
    const fold = (value: string) => this.options.sensitivity === "base" || this.options.sensitivity === "accent" ? value.toLowerCase() : value;
    if (this.options.numeric) {
      const a = fold(left).split(/(\d+)/);
      const b = fold(right).split(/(\d+)/);
      for (let index = 0; index < Math.min(a.length, b.length); index++) {
        const order = index % 2 ? Number(a[index]) - Number(b[index]) : a[index]!.localeCompare(b[index]!);
        if (order) return Math.sign(order);
      }
      return a.length - b.length;
    }
    return fold(left).localeCompare(fold(right));
  };
}

export function installIntl(): void {
  if (typeof globalThis.Intl !== "undefined") return;
  (globalThis as Record<string, unknown>).Intl = {
    DateTimeFormat, NumberFormat, Collator,
    getCanonicalLocales: (locales?: string | string[]) => (locales === undefined ? [] : typeof locales === "string" ? [locales] : locales).map(resolveLocale),
  };
  // QuickJS's own toLocale* ignore the locale (no grouping, English dates).
  Number.prototype.toLocaleString = function (this: number, locales?: string | string[], options?: NumberOptions) {
    return new NumberFormat(locales, options).format(Number(this));
  };
  Date.prototype.toLocaleString = function (this: Date, locales?: string | string[], options?: DateTimeOptions) {
    return new DateTimeFormat(locales, options && dateKey(options) ? options : { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", ...options }).format(this);
  };
  Date.prototype.toLocaleDateString = function (this: Date, locales?: string | string[], options?: DateTimeOptions) {
    return new DateTimeFormat(locales, options && dateKey(options) ? options : { year: "numeric", month: "numeric", day: "numeric", ...options }).format(this);
  };
  Date.prototype.toLocaleTimeString = function (this: Date, locales?: string | string[], options?: DateTimeOptions) {
    return new DateTimeFormat(locales, options && dateKey(options) ? options : { hour: "numeric", minute: "2-digit", second: "2-digit", ...options }).format(this);
  };
}

/** For tests: the shim's classes, without installing them. */
export const txikiIntl = { DateTimeFormat, NumberFormat, Collator };
