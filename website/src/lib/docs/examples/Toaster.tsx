import { Button, Column, Toaster, theme, type ToastItem } from "@tarve/core";

let toasts: ToastItem[] = [];

<Column
  align="center"
  style={{ position: "relative", width: 440, height: 240, padding: { top: 24 }, radius: 12, borderWidth: 1, borderColor: theme.colors.border }}
>
  <Button
    onClick={() => {
      toasts = [...toasts.slice(-1), { id: String(Date.now()), title: "Exported", description: "report.pdf is ready." }];
    }}
  >
    Export
  </Button>
  <Toaster
    toasts={toasts}
    position="bottom-right"
    onDismiss={(id) => {
      toasts = toasts.filter((toast) => toast.id !== id);
    }}
  />
</Column>;
