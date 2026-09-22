import {
  Button,
  Column,
  Image,
  Modal,
  Row,
  Scroll,
  Text,
  TextInput,
  TitleBar,
  View,
  Window,
  Theme,
  darkTheme,
  lightTheme,
  theme,
  type Child,
  type Style
} from "tarve";
import studio from "./assets/studio.png" with { type: "file" };

const c = theme.colors;
const card: Style = {
  background: c.card,
  borderWidth: 1,
  borderColor: c.border,
  radius: 10,
  padding: 22,
  gap: 18,
};
const divider: Style = { height: 1, background: c.border, shrink: 0 };
let clicks = 0;
let name = "Alex Morgan";
let email = "alex@example.com";
let status = "All changes saved";
let selected = "Overview";
let modalOpen = false;
let darkMode = false;
function Card({
  title,
  description,
  children,
  style,
}: {
  title: string;
  description: string;
  children: Child;
  style?: Style;
}) {
  return (
    <Column style={{ ...card, ...style }}>
      <Column gap={4}>
        <Text size={17} weight={600}>
          {title}
        </Text>
        <Text size={13} color={c.mutedForeground}>
          {description}
        </Text>
      </Column>
      {children}
    </Column>
  );
}


export function App() {
  const appTheme = Theme.create(darkMode ? darkTheme : lightTheme, {
    focusOutline: {
      outlineWidth: 0,
      outlineStyle: "none",
    },
  });
  return (
    <Window
      title="Tarve — Native workspace"
      theme={appTheme}
      width={1140}
      height={870}
      minWidth={860}
      minHeight={640}
    >
      <TitleBar title="Tarve — Native workspace" />
      <Row
        style={{
          height: 70,
          padding: { left: 32, right: 32 },
          background: c.card,
          borderWidth: {
            bottom: 1,
          },
          borderColor: c.border,
        }}
        justify="between"
      >
        <Row gap={12}>
          <View
            style={{
              width: 32,
              height: 32,
              background: c.primary,
              radius: 8,
              justify: "center",
              align: "center",
            }}
          >
            <Text color={c.primaryForeground} weight={700} size={18}>
              t
            </Text>
          </View>
          <Text size={18} weight={600}>
            tarve
          </Text>
          <View
            style={{ width: 1, height: 22, background: c.border, margin: { left: 12, right: 12 } }}
          />
          <Text color={c.mutedForeground}>Personal workspace</Text>
        </Row>
        <Row gap={10}>
          <Button
            id="theme-toggle"
            size="sm"
            variant="ghost"
            onClick={() => {
              darkMode = !darkMode;
            }}
          >
            Theme
          </Button>
          <View
            style={{
              background: c.successMuted,
              radius: 20,
              padding: { left: 10, right: 10, top: 4, bottom: 4 },
            }}
          >
            <Text size={12} color={c.success}>
              ● Connected
            </Text>
          </View>
          <View
            style={{
              width: 32,
              height: 32,
              background: c.muted,
              radius: 16,
              align: "center",
              justify: "center",
            }}
          >
            <Text size={12} weight={600}>
              AM
            </Text>
          </View>
        </Row>
      </Row>
      <Scroll id="page-scroll" flex={1}>
        <Column padding={32} gap={24} style={{ width: "100%" }}>
          <Row justify="between" align="end">
            <Column gap={5}>
              <Text size={28} weight={650}>
                Your workspace
              </Text>
              <Text color={c.mutedForeground}>A little space to make something great.</Text>
            </Column>
            <Button
              id="new-project"
              onClick={() => {
                clicks++;
                status = `Project ${clicks} created`;
                modalOpen = true;
              }}
            >
              + New project
            </Button>
          </Row>
          <Row gap={4} style={{ padding: 4, background: c.muted, radius: 8, width: 316 }}>
            {["Overview", "Activity", "Settings"].map((tab) => (
              <Button
                key={tab}
                id={`tab-${tab.toLowerCase()}`}
                size="sm"
                variant="ghost"
                style={{
                  flex: 1,
                  background: selected === tab ? c.card : "#00000000",
                  foreground: selected === tab ? c.foreground : c.mutedForeground,
                  outlineStyle: "none",
                  focus: { outlineStyle: "none" },
                }}
                onClick={() => {
                  selected = tab;
                  status = `${tab} selected`;
                }}
              >
                {tab}
              </Button>
            ))}
          </Row>
          <View id="stats-grid" style={{ display: "grid", columns: 3, gap: 16 }}>
            {[
              ["Projects", String(12 + clicks), "+2 this month"],
              ["Team members", "8", "Across 3 teams"],
              ["Storage used", "2.4 GB", "of 10 GB available"],
            ].map(([label, value, caption]) => (
              <Column key={label} style={{ ...card, padding: 20, gap: 10 }}>
                <Text size={13} weight={500}>
                  {label}
                </Text>
                <Text size={27} weight={650}>
                  {value}
                </Text>
                <Text size={12} color={c.mutedForeground}>
                  {caption}
                </Text>
              </Column>
            ))}
          </View>
          <Row gap={20} align="start">
            <Column flex={1} gap={20}>
              <Card title="Profile" description="Your details, just the way you like them.">
                <Column gap={7}>
                  <Text size={13} weight={500}>
                    Full name
                  </Text>
                  <TextInput
                    id="name-input"
                    value={name}
                    placeholder="Your name"
                    onChange={(value) => {
                      name = value;
                      status = "Unsaved changes";
                    }}
                  />
                </Column>
                <Column gap={7}>
                  <Text size={13} weight={500}>
                    Email address
                  </Text>
                  <TextInput
                    id="email-input"
                    value={email}
                    placeholder="you@example.com"
                    onChange={(value) => {
                      email = value;
                      status = "Unsaved changes";
                    }}
                  />
                </Column>
                <View style={divider} />
                <Row justify="between">
                  <Text id="save-status" size={12} color={c.mutedForeground}>
                    {status}
                  </Text>
                  <Button
                    id="save"
                    onClick={() => {
                      status = `Saved for ${name || "you"}`;
                    }}
                  >
                    Save changes
                  </Button>
                </Row>
              </Card>
              <Card title="Make it yours" description="A quiet place for your next idea.">
                <Image
                  id="local-image"
                  src={studio}
                  height={144}
                  style={{ width: "100%", radius: 6 }}
                  fit="cover"
                />
                <Row justify="between">
                  <Column gap={3}>
                    <Text weight={500}>A fresh perspective</Text>
                    <Text size={12} color={c.mutedForeground}>
                      Start with a blank canvas.
                    </Text>
                  </Column>
                  <Button
                    variant="outline"
                    size="sm"
                    id="explore"
                    onClick={() => {
                      status = "Your canvas is ready";
                    }}
                  >
                    Explore →
                  </Button>
                </Row>
              </Card>
            </Column>
            <Column flex={1} gap={20}>
              <Card title="Buttons" description="The right emphasis for every action.">
                <Row gap={10} style={{ wrap: true }}>
                  <Button
                    id="open-modal"
                    variant="outline"
                    onClick={() => {
                      modalOpen = true;
                    }}
                  >
                    Open dialog
                  </Button>
                  <Button
                    id="variant-default"
                    onClick={() => {
                      status = "Primary action clicked";
                    }}
                  >
                    Default
                  </Button>
                  <Button
                    id="variant-secondary"
                    variant="secondary"
                    onClick={() => {
                      status = "Secondary action clicked";
                    }}
                  >
                    Secondary
                  </Button>
                  <Button
                    id="variant-outline"
                    variant="outline"
                    onClick={() => {
                      status = "Outline action clicked";
                    }}
                  >
                    Outline
                  </Button>
                </Row>
                <Row gap={10} style={{ wrap: true }}>
                  <Button
                    id="variant-ghost"
                    variant="ghost"
                    onClick={() => {
                      status = "Ghost action clicked";
                    }}
                  >
                    Ghost
                  </Button>
                  <Button
                    id="variant-destructive"
                    variant="destructive"
                    onClick={() => {
                      status = "Destructive variant clicked (demo only)";
                    }}
                  >
                    Destructive
                  </Button>
                  <Button id="disabled-button" disabled>
                    Disabled
                  </Button>
                </Row>
              </Card>
              <Card title="Recent activity" description="The latest from your workspace.">
                <Scroll id="activity-scroll" style={{ height: 252 }}>
                  <Column gap={0}>
                    {Array.from({ length: 12 }, (_, i) => (
                      <Row
                        key={i}
                        id={`activity-${i}`}
                        gap={12}
                        style={{ height: 64, padding: { right: 16 }, borderWidth: 0 }}
                      >
                        <View
                          style={{
                            width: 34,
                            height: 34,
                            radius: 17,
                            background: c.muted,
                            align: "center",
                            justify: "center",
                          }}
                        >
                          <Text size={12} weight={500}>
                            {["JD", "SK", "AM", "RL"][i % 4]}
                          </Text>
                        </View>
                        <Column flex={1} gap={3}>
                          <Text size={13} weight={500}>
                            {
                              [
                                "Jamie updated the design",
                                "Sofia shared a new file",
                                "You created a project",
                                "Robin joined the team",
                              ][i % 4]
                            }
                          </Text>
                          <Text size={12} color={c.mutedForeground}>
                            {i + 2} minutes ago
                          </Text>
                        </Column>
                        <View
                          style={{
                            width: 6,
                            height: 6,
                            radius: 3,
                            background: i < 2 ? c.success : c.border,
                          }}
                        />
                      </Row>
                    ))}
                  </Column>
                </Scroll>
                <View style={divider} />
                <Text size={12} color={c.mutedForeground}>
                  You're all caught up. Scroll for earlier updates.
                </Text>
              </Card>
            </Column>
          </Row>
          <Row justify="between">
            <Text size={12} color={c.mutedForeground}>
              Your ideas. Your workspace.
            </Text>
            <Text size={12} color={c.mutedForeground}>
              Made with Tarve
            </Text>
          </Row>
        </Column>
      </Scroll>
      <Modal
        id="demo-modal"
        open={modalOpen}
        showClose={true}
        onOpenChange={(open) => {
          modalOpen = open;
        }}
        title="Create project"
        description="Start a new project in your workspace. You can change these details later."
        footer={[
          <Button
            key="cancel"
            variant="outline"
            onClick={() => {
              modalOpen = false;
            }}
          >
            Cancel
          </Button>,
          <Button
            key="create"
            onClick={() => {
              clicks++;
              status = `Project ${clicks} created`;
              modalOpen = false;
            }}
          >
            Create project
          </Button>,
        ]}
      >
        <Column gap={7}>
          <Text size={13} weight={500}>Project name</Text>
          <TextInput placeholder="My new project" />
        </Column>
      </Modal>
    </Window>
  );
}
