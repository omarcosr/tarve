import { Button, Column, Toaster, type ToastItem } from "@tarve/core";

let toasts: ToastItem[] = [];

<Column>
  <Button
    onClick={() => {
      toasts = [...toasts, { id: String(Date.now()), title: "Exported", description: "report.pdf is ready." }];
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
