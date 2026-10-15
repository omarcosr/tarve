/**
 * Generates packages/core/txiki/intl-data.ts from Bun's ICU: number separators and
 * date templates per locale, so the txiki.js Intl shim formats like Bun and Node.
 *   bun scripts/generate-txiki-intl.ts          (write)
 *   bun scripts/generate-txiki-intl.ts --check  (fail when stale)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LOCALES = [
  "en-US", "en-GB", "en-IN", "en-CA", "en-AU", "pt-BR", "pt-PT", "es-ES", "es-MX", "es-AR", "fr-FR", "fr-CA",
  "de-DE", "de-CH", "de-AT", "it-IT", "nl-NL", "sv-SE", "nb-NO", "da-DK", "fi-FI", "pl-PL", "cs-CZ", "ru-RU",
  "uk-UA", "tr-TR", "ja-JP", "zh-CN", "zh-TW", "ko-KR", "id-ID", "vi-VN", "he-IL",
];

/** Option sets the shim formats exactly; others fall back to a generic composition. */
export const DATE_OPTIONS: Intl.DateTimeFormatOptions[] = [
  {},
  { hour: "2-digit", minute: "2-digit" }, { hour: "numeric", minute: "2-digit" }, { hour: "numeric", minute: "2-digit", second: "2-digit" },
  { hour: "2-digit", minute: "2-digit", second: "2-digit" },
  { hour: "2-digit", minute: "2-digit", hour12: false }, { hour: "2-digit", minute: "2-digit", hour12: true },
  { hour: "numeric", minute: "2-digit", hour12: false }, { hour: "numeric", minute: "2-digit", hour12: true },
  { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: false }, { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true },
  { weekday: "short", day: "numeric", month: "short" }, { weekday: "long", day: "numeric", month: "long" },
  { month: "short", day: "numeric" }, { month: "long", day: "numeric" },
  { month: "short", day: "numeric", year: "numeric" }, { month: "long", day: "numeric", year: "numeric" },
  { weekday: "long", month: "long", day: "numeric", year: "numeric" }, { weekday: "short", month: "short", day: "numeric", year: "numeric" },
  { year: "numeric", month: "numeric", day: "numeric" }, { year: "numeric", month: "2-digit", day: "2-digit" },
  { month: "long", year: "numeric" }, { month: "short", year: "numeric" },
  { weekday: "short" }, { weekday: "long" }, { month: "short" }, { month: "long" },
  { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" },
  { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
  { dateStyle: "full" }, { dateStyle: "long" }, { dateStyle: "medium" }, { dateStyle: "short" },
  { timeStyle: "short" }, { timeStyle: "medium" },
  { dateStyle: "medium", timeStyle: "short" }, { dateStyle: "short", timeStyle: "short" },
];

export function optionKey(options: Record<string, unknown>): string {
  return Object.keys(options).filter(key => options[key] !== undefined).sort().map(key => key + "=" + String(options[key])).join(",");
}

/** Template token letters: the part type, then 1 when padded (or a 2-digit year). */
const TOKEN: Record<string, string> = { weekday: "w", month: "M", day: "d", year: "y", hour: "h", minute: "m", second: "s", dayPeriod: "a", era: "G" };

function generate() {
  const pool: string[][] = [];
  const poolIndex = new Map<string, number>();
  const intern = (list: string[]) => {
    const key = JSON.stringify(list);
    let index = poolIndex.get(key);
    if (index === undefined) { index = pool.length; pool.push(list); poolIndex.set(key, index); }
    return index;
  };
  const templatePool: string[] = [];
  const templateIndex = new Map<string, number>();
  const internTemplate = (template: string) => {
    let index = templateIndex.get(template);
    if (index === undefined) { index = templatePool.length; templatePool.push(template); templateIndex.set(template, index); }
    return index;
  };
  const locales: Record<string, unknown> = {};
  for (const locale of LOCALES) {
    const parts = (value: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat(locale, options).formatToParts(value);
    const big = parts(12345678.5);
    const group = big.find(part => part.type === "group")?.value ?? "";
    const decimal = big.find(part => part.type === "decimal")?.value ?? ".";
    const integers = big.filter(part => part.type === "integer").map(part => part.value.length);
    const secondary = integers.length > 2 ? integers[1]! : 3;
    const minGroup = parts(1234).some(part => part.type === "group") ? 1 : 2;
    // Everything before the digits of -1: some locales add a direction mark (he-IL "\u200e-").
    const minusParts = parts(-1);
    const minus = minusParts.slice(0, minusParts.findIndex(part => part.type === "integer")).map(part => part.value).join("");
    const percent = new Intl.NumberFormat(locale, { style: "percent" }).formatToParts(0.26).map(part => part.type === "integer" ? "{n}" : part.value).join("");
    // Per DATE_OPTIONS entry: [template, month names, weekday names, day period per hour] (pool indexes, -1 = none).
    // Day periods are per hour: some locales name more than two (zh-TW 凌晨, 中午, 晚上).
    const dates: number[][] = [];
    for (const options of DATE_OPTIONS) {
      const format = new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" });
      const sample = format.formatToParts(Date.UTC(2026, 2, 5, 8, 5, 9));
      let template = sample.map(part => {
        if (part.type === "literal") return part.value.replace(/[{}]/g, "");
        if (!TOKEN[part.type]) throw new Error(`${locale}: unsupported part ${part.type}`);
        const flag = part.type === "year" ? (part.value.length === 2 ? 1 : 0) : (/^0\d$/.test(part.value) ? 1 : 0);
        return `{${TOKEN[part.type]}${flag}}`;
      }).join("");
      const hourOf = (date: number) => format.formatToParts(date).find(part => part.type === "hour")?.value;
      if (hourOf(Date.UTC(2026, 2, 5, 8)) !== undefined) {
        const late = Number(hourOf(Date.UTC(2026, 2, 5, 20))), midnight = Number(hourOf(Date.UTC(2026, 2, 5, 0)));
        template += `{c${late === 20 ? (midnight === 24 ? 24 : 23) : (midnight === 0 ? 11 : 12)}}`;
      }
      const pick = (type: string, at: number[]) => at.map(date => format.formatToParts(date).find(part => part.type === type)?.value ?? "");
      const textMonth = sample.some(part => part.type === "month" && !/^\d+$/.test(part.value));
      dates.push([
        internTemplate(template),
        textMonth ? intern(pick("month", Array.from({ length: 12 }, (_, month) => Date.UTC(2026, month, 5, 8)))) : -1,
        sample.some(part => part.type === "weekday") ? intern(pick("weekday", Array.from({ length: 7 }, (_, day) => Date.UTC(2026, 2, 1 + day, 8)))) : -1,
        sample.some(part => part.type === "dayPeriod") ? intern(pick("dayPeriod", Array.from({ length: 24 }, (_, hour) => Date.UTC(2026, 2, 5, hour)))) : -1,
      ]);
    }
    locales[locale] = [group, decimal, minGroup, secondary, percent, minus, dates];
  }
  return { pool, templatePool, locales };
}

/** What this host's ICU produces now (intl-data.ts holds the committed copy). */
export const data = generate();
const icu = process.versions.icu ?? "unknown";
const source = `// Generated by scripts/generate-txiki-intl.ts from ICU ${icu} (Bun ${Bun.version}). Do not edit.
/** [group, decimal, minimum grouping digits, secondary group size, percent pattern, minus sign, date formats per DATE_OPTIONS]. */
export type LocaleData = [string, string, number, number, string, string, number[][]];
export const DATE_KEYS: string[] = ${JSON.stringify(DATE_OPTIONS.map(options => optionKey(options as Record<string, unknown>)))};
export const TEMPLATES: string[] = ${JSON.stringify(data.templatePool)};
export const NAMES: string[][] = ${JSON.stringify(data.pool)};
export const LOCALES: Record<string, LocaleData> = ${JSON.stringify(data.locales)};
`;
const target = join(import.meta.dir, "../packages/core/txiki/intl-data.ts");
if (process.argv.includes("--check")) {
  const current = readFileSync(target, "utf8");
  // The data is ICU's: another ICU (Bun on Windows uses the system's) formats some
  // locales differently, which says nothing about whether the file is stale.
  // Bun on Windows also follows the machine's regional settings (the Windows CI runner
  // differs from a desktop with the same ICU): the Linux and macOS gates check it.
  const generatedWith = /from ICU (\S+) /.exec(current)?.[1];
  if (process.platform === "win32" && process.env.TARVE_INTL_CHECK !== "1") {
    console.log("intl-data.ts check skipped on Windows (TARVE_INTL_CHECK=1 forces it)");
  } else if (generatedWith !== icu) {
    console.log(`intl-data.ts check skipped: generated with ICU ${generatedWith ?? "?"}, this Bun has ICU ${icu}`);
  } else if (current.replace(/\(Bun [^)]*\)/, "") !== source.replace(/\(Bun [^)]*\)/, "")) {
    const expected = data.locales as Record<string, unknown>;
    const committed = new Map<string, string>();
    for (const match of current.matchAll(/"([a-z]{2}-[A-Z]{2})":(\[.*?\]\]\])/g)) committed.set(match[1]!, match[2]!);
    const differing = Object.keys(expected).filter(locale => committed.get(locale) !== JSON.stringify(expected[locale]));
    console.error(`intl-data.ts is stale${differing.length ? ` (locales: ${differing.join(", ")})` : ""}`);
    process.exit(1);
  }
} else if (import.meta.main) {
  writeFileSync(target, source);
  console.log(`intl-data.ts: ${source.length} bytes, ${LOCALES.length} locales`);
}
