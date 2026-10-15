import { expect, mock, test } from "bun:test";
import { DATE_OPTIONS, LOCALES } from "../../../scripts/generate-txiki-intl";

// intl.ts runs inside txiki.js: stand in for its globals.
mock.module("tjs:ffi", () => ({ dlopen: () => { throw new Error("no ffi in tests"); } }));
Object.assign(globalThis, { TARVE_TXIKI_PLATFORM: "linux", tjs: { env: { LANG: "pt_BR.UTF-8" } } });
const { txikiIntl } = await import("./intl");

const dates = [Date.UTC(2026, 9, 15, 8, 5, 9), Date.UTC(2024, 0, 1, 0, 0, 0), Date.UTC(2025, 11, 31, 23, 59, 59), Date.UTC(2026, 5, 7, 12, 30, 0), Date.UTC(2026, 1, 28, 13, 7, 3)];
const numbers = [0, 7, 1234, 1234.5, -9876.54321, 12345678.9, 0.256, 1e9, -0.004, 999.9999];

test("txiki.js Intl numbers match ICU for every bundled locale", () => {
  const mismatches: string[] = [];
  for (const locale of LOCALES) {
    for (const value of numbers) {
      for (const options of [{}, { style: "percent" }, { maximumFractionDigits: 1 }, { minimumFractionDigits: 2 }, { useGrouping: false }] as Intl.NumberFormatOptions[]) {
        const expected = new Intl.NumberFormat(locale, options).format(value);
        const actual = new txikiIntl.NumberFormat(locale, options as never).format(value);
        if (actual !== expected) mismatches.push(`${locale} ${value} ${JSON.stringify(options)}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
      }
    }
  }
  expect(mismatches.slice(0, 10)).toEqual([]);
});

test("txiki.js Intl dates match ICU for every bundled locale and option set", () => {
  const mismatches: string[] = [];
  for (const locale of LOCALES) {
    for (const options of DATE_OPTIONS) {
      for (const date of dates) {
        const expected = new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(date);
        const actual = new txikiIntl.DateTimeFormat(locale, { ...options, timeZone: "UTC" } as never).format(date);
        if (actual !== expected) mismatches.push(`${locale} ${JSON.stringify(options)}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
      }
    }
  }
  expect(mismatches.slice(0, 10)).toEqual([]);
});

test("the default locale comes from the system and unknown locales fall back by language", () => {
  expect(new txikiIntl.NumberFormat().format(50000)).toBe("50.000");
  expect(new txikiIntl.NumberFormat("pt-AO").resolvedOptions().locale).toBe("pt-BR");
  expect(new txikiIntl.NumberFormat("xx").format(1234.5)).toBe("1,234.5");
});
