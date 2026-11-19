import { expect, test } from "bun:test";
import { crashReport, fatalDialogText, reportFatalError } from "./fatal";

test("the crash log names the app, runtime and platform, and walks the error's causes", () => {
  const error = new Error("GPU device lost", { cause: new Error("DXGI_ERROR_DEVICE_REMOVED") });
  const report = crashReport(error, { name: "Notes", version: "1.2.0", appId: "Acme.Notes" }, new Date("2026-11-18T10:00:00.000Z"));
  expect(report).toContain("time: 2026-11-18T10:00:00.000Z");
  expect(report).toContain("app: Notes 1.2.0 (Acme.Notes)");
  expect(report).toContain(`platform: ${process.platform}-${process.arch}`);
  expect(report).toMatch(/runtime: (Bun|Node\.js|txiki\.js)/);
  expect(report).toContain("Error: GPU device lost");
  expect(report).toContain("caused by:\nError: DXGI_ERROR_DEVICE_REMOVED");
});

test("a stack without the message header (QuickJS) still names the error", () => {
  const error = new Error("view failed");
  error.stack = "    at Broken (app.js:23:52067)\n";
  expect(crashReport(error, {}, new Date(0))).toContain("error:\nError: view failed\n    at Broken (app.js:23:52067)\n");
});

test("the dialog names the app, the reason and the log", () => {
  expect(fatalDialogText(new Error("no GPU adapter"), { name: "Notes" }, "C:\\logs\\crash.log")).toEqual({
    title: "Notes stopped because of an error",
    message: "no GPU adapter\n\nDetails were saved to:\nC:\\logs\\crash.log",
  });
  expect(fatalDialogText(new Error(""), {}, undefined)).toEqual({ title: "The app stopped because of an error", message: "Error" });
});

test("outside a built executable nothing is written nor shown", () => {
  expect(reportFatalError(new Error("boom"))).toBeUndefined();
});
