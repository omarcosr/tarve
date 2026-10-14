import { Column, Icon, Pressable, Progress, Row, Text, Window, darkTheme, type SvgNode } from "@tarve/core";

export interface Meter {
  /** 0–1 */
  value: number;
  detail: string;
}

export interface WidgetState {
  now: Date;
  cpu: Meter;
  memory: Meter;
  /** Keep the widget under every window (on), or let it come forward like any window (off). */
  behind: boolean;
}

const colors = darkTheme.colors;
const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const date = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });
const small = { fontSize: 11, foreground: colors.mutedForeground };

function Bar({ label, meter, color }: { label: string; meter: Meter; color: string }) {
  return (
    <Column style={{ gap: 3 }}>
      <Row style={{ justify: "between" }}>
        <Text style={small}>{label}</Text>
        <Text style={{ ...small, fontVariantNumeric: "tabular-nums" }}>{meter.detail}</Text>
      </Row>
      <Progress value={meter.value} max={1} label={label} style={{ height: 4, radius: 2, background: "#ffffff14", foreground: color }} />
    </Column>
  );
}

const closeIcon: SvgNode[] = [["path", { d: "M6 6l12 12M18 6 6 18" }]];
// Two stacked sheets, the front one hollow: "stays behind other windows".
const behindIcon: SvgNode[] = [["rect", { x: 8, y: 8, width: 13, height: 13, rx: 2 }], ["path", { d: "M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" }]];

function IconButton({ id, icon, label, active, onClick }: {
  id: string; icon: SvgNode[]; label: string; active?: boolean; onClick: () => void;
}) {
  return (
    <Pressable id={id} onClick={onClick} focusable={false}
      control={active === undefined ? { role: "button", label } : { role: "switch", label, checked: active }}
      style={{ width: 24, height: 24, radius: 6, align: "center", justify: "center",
        background: active ? "#6366f140" : "#ffffff0d", hover: { background: active ? "#6366f166" : "#ffffff26" } }}>
      <Icon iconNode={icon} size={12} strokeWidth={2} color={active ? "#c7d2fe" : colors.mutedForeground} />
    </Pressable>
  );
}

/** A 3 × 2 cell desktop widget: drag it anywhere on the desktop and it drops into free cells. */
export function WidgetView({ state, onToggleBehind, onHide }: {
  state: WidgetState; onToggleBehind: () => void; onHide: () => void;
}) {
  return (
    <Window title="Desktop widget" desktopWidget={{ columns: 3, rows: 2 }} position="top-right" theme={darkTheme}
      level={state.behind ? "alwaysOnBottom" : "normal"}
      onCloseRequest={event => { event.preventDefault(); onHide(); }}
      style={{ background: "#14141c", borderWidth: 1, borderColor: "#ffffff14" }}>
      <Column dragRegion flex={1} padding={14}
        style={{ gap: 8, justify: "between", background: "linear-gradient(160deg, #26263a, #14141c 70%)" }}>
        <Row style={{ justify: "between", align: "start" }}>
          <Column>
            <Text style={{ fontSize: 34, fontWeight: 300, fontVariantNumeric: "tabular-nums" }}>{time.format(state.now)}</Text>
            <Text style={{ fontSize: 12, foreground: colors.mutedForeground }}>{date.format(state.now)}</Text>
          </Column>
          <Row style={{ gap: 4 }}>
            <IconButton id="behind" icon={behindIcon} label="Always behind windows" active={state.behind} onClick={onToggleBehind} />
            <IconButton id="hide" icon={closeIcon} label="Hide widget" onClick={onHide} />
          </Row>
        </Row>
        <Column style={{ gap: 6 }}>
          <Bar label="CPU" meter={state.cpu} color="linear-gradient(90deg, #38bdf8, #6366f1)" />
          <Bar label="Memory" meter={state.memory} color="linear-gradient(90deg, #a78bfa, #ec4899)" />
        </Column>
      </Column>
    </Window>
  );
}
