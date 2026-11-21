const { app, BrowserWindow, Menu } = require("electron");
Menu.setApplicationMenu(null);
const path = require("node:path");
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1024, height: 760, useContentSize: true, title: "bench", backgroundColor: "#ffffff" });
  win.loadFile(path.join(__dirname, "dist", "index.html"), { query: { scene: process.env.SCENE ?? "empty" } });
});
app.on("window-all-closed", () => app.quit());
