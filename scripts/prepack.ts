export {};

if (process.env.TARVE_SKIP_PREPACK === "1") {
  console.log("Tarve prepack: using prepared package staging.");
} else {
  await import("./package");
}
