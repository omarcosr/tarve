import { Badge, Column, Text, tw } from "@tarve/core";

const active = true;

<Column style={tw("gap-2 p-4 w-80 rounded-xl border border-border bg-card", active && "ring-2 ring-primary/40")}>
  <Text style={tw("text-sm font-semibold text-foreground")}>tw() composes like clsx</Text>
  <Text style={tw("text-xs text-muted-foreground")}>Falsy arguments are skipped, later classes win.</Text>
  <Badge style={tw("self-start")}>{active ? "Active" : "Idle"}</Badge>
</Column>;
