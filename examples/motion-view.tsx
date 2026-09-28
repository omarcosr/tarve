import {
  AnimatePresence,
  Button,
  Column,
  Row,
  Scroll,
  Text,
  TitleBar,
  View,
  Window,
  theme,
  type Child,
  type MotionEasing,
  type Style,
} from "tarve";

const c = theme.colors;

const panel: Style = {
  background: c.card,
  borderWidth: 1,
  borderColor: c.border,
  radius: 12,
  padding: 20,
  gap: 16,
};

const easings: MotionEasing[] = ["linear", "ease", "easeIn", "easeOut", "easeInOut"];

let expanded = false;
let easingForward = false;
let presenceVisible = true;
let retargetStep = 0;
let completion = "No transition has completed yet.";

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: Child;
}) {
  return (
    <Column style={panel}>
      <Column gap={4}>
        <Text size={17} weight={650}>{title}</Text>
        <Text size={13} color={c.mutedForeground}>{description}</Text>
      </Column>
      {children}
    </Column>
  );
}

function EasingRow({ easing }: { easing: MotionEasing }) {
  return (
    <Row gap={14} align="center">
      <Text size={12} color={c.mutedForeground} style={{ width: 76 }}>{easing}</Text>
      <View
        style={{
          width: easingForward ? 360 : 120,
          height: 12,
          radius: 6,
          background: c.primary,
          transition: {
            width: { duration: 700, easing },
          },
        }}
      />
    </Row>
  );
}

export function App() {
  const retargetWidths = [150, 420, 240, 500];
  const retargetWidth = retargetWidths[retargetStep % retargetWidths.length]!;

  return (
    <Window
      title="Tarve — Native motion"
      width={940}
      height={820}
      minWidth={760}
      minHeight={620}
      position="center"
    >
      <TitleBar title="Tarve — Native motion" />

      <Scroll flex={1}>
        <Column padding={28} gap={20} style={{ width: "100%" }}>
          <Column gap={6}>
            <Text size={28} weight={700}>Native motion</Text>
            <Text color={c.mutedForeground}>
              Rust owns interpolation and frame scheduling. Bun only sends new targets.
            </Text>
          </Column>

          <Section
            title="Enter transition"
            description="motionFrom supplies the mount-time values. Width, opacity, and radius animate without a Bun frame loop."
          >
            <View
              id="enter-demo"
              motionFrom={{ width: 120, opacity: 0, radius: 2 }}
              onTransitionEnd={({ property }) => {
                completion = `Enter demo completed: ${property}`;
              }}
              style={{
                width: 430,
                height: 76,
                opacity: 1,
                radius: 18,
                background: c.primary,
                transition: {
                  width: { duration: 650, easing: "easeOut" },
                  opacity: { duration: 420, easing: "linear" },
                  radius: { duration: 650, easing: "easeOut" },
                },
              }}
            >
              <Row align="center" justify="center" style={{ width: "100%", height: "100%" }}>
                <Text color={c.primaryForeground} weight={650}>Mounted with motionFrom</Text>
              </Row>
            </View>
          </Section>

          <Section
            title="Numeric transitions"
            description="A single declarative update changes size, opacity, and corner radius."
          >
            <Row gap={14} align="center">
              <Button
                id="toggle-transition"
                onClick={() => {
                  expanded = !expanded;
                }}
              >
                {expanded ? "Collapse" : "Expand"}
              </Button>
              <Text size={12} color={c.mutedForeground}>
                {expanded ? "420 × 110, opacity 1" : "220 × 72, opacity 0.62"}
              </Text>
            </Row>

            <View
              id="numeric-transition-demo"
              onTransitionEnd={({ property }) => {
                completion = `Numeric transition completed: ${property}`;
              }}
              style={{
                width: expanded ? 420 : 220,
                height: expanded ? 110 : 72,
                opacity: expanded ? 1 : 0.62,
                radius: expanded ? 24 : 8,
                background: c.secondary,
                transition: {
                  width: { duration: 420, easing: "easeOut" },
                  height: { duration: 420, easing: "easeOut" },
                  opacity: { duration: 260, easing: "linear" },
                  radius: { duration: 420, easing: "easeInOut" },
                },
              }}
            />
          </Section>

          <Section
            title="Easing curves"
            description="All five native easing curves run over the same distance and duration."
          >
            <Button
              id="run-easings"
              size="sm"
              variant="outline"
              onClick={() => {
                easingForward = !easingForward;
              }}
            >
              Run easing comparison
            </Button>
            <Column gap={12}>
              {easings.map((easing) => <EasingRow key={easing} easing={easing} />)}
            </Column>
          </Section>

          <Section
            title="Retarget while moving"
            description="Click repeatedly before the previous motion finishes. Each new transition starts from the current interpolated width."
          >
            <Row gap={12} align="center">
              <Button
                id="retarget"
                onClick={() => {
                  retargetStep++;
                }}
              >
                Retarget
              </Button>
              <Text size={12} color={c.mutedForeground}>Target: {retargetWidth}px</Text>
            </Row>
            <View
              id="retarget-demo"
              style={{
                width: retargetWidth,
                height: 54,
                radius: 12,
                background: c.success,
                transition: {
                  width: { duration: 850, easing: "easeInOut" },
                },
              }}
            />
          </Section>

          <Section
            title="AnimatePresence"
            description="The exiting node stays mounted until every native exit transition has completed."
          >
            <Button
              id="toggle-presence"
              variant="outline"
              onClick={() => {
                presenceVisible = !presenceVisible;
              }}
            >
              {presenceVisible ? "Hide card" : "Show card"}
            </Button>

            <View style={{ height: 112 }}>
              <AnimatePresence
                id="presence-demo"
                present={presenceVisible}
                enter={{ opacity: 0, width: 180 }}
                exit={{ opacity: 0, width: 180 }}
                transition={{
                  opacity: { duration: 260, easing: "linear" },
                  width: { duration: 420, easing: "easeOut" },
                }}
              >
                <Column
                  id="presence-card"
                  style={{
                    width: 430,
                    height: 92,
                    opacity: 1,
                    radius: 16,
                    background: c.secondary,
                    padding: 16,
                    gap: 4,
                  }}
                  onTransitionEnd={({ property }) => {
                    completion = `Presence transition completed: ${property}`;
                  }}
                >
                  <Text weight={650}>Retained during exit</Text>
                  <Text size={12} color={c.mutedForeground}>
                    Removal happens only after native motion completion.
                  </Text>
                </Column>
              </AnimatePresence>
            </View>
          </Section>

          <View
            style={{
              background: c.muted,
              radius: 10,
              padding: 14,
            }}
          >
            <Text id="completion-status" size={12} color={c.mutedForeground}>{completion}</Text>
          </View>
        </Column>
      </Scroll>
    </Window>
  );
}
