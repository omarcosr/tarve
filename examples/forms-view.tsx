import {
  Accordion, Badge, Button, Card, Checkbox, Column, Progress, RadioGroup, Row,
  Scroll, Separator, Slider, Switch, Tabs, Text, TextInput, Window, theme,
} from "tarve";

const c = theme.colors;
let name = "";
let updates = false;
let notifications = true;
let plan = "team";
let volume = 36;
let tab = "profile";
let section: string | undefined = "details";
let saved = false;

export function App() {
  return (
    <Window title="Tarve — Forms" width={900} height={800} minWidth={700} minHeight={560}>
      <Scroll flex={1}>
        <Column gap={24} padding={32} style={{ width: "100%" }}>
          <Row justify="between">
            <Column gap={4}>
              <Text size={26} weight={650}>Workspace settings</Text>
              <Text color={c.mutedForeground}>Native controls with mouse and keyboard input.</Text>
            </Column>
            <Badge variant={saved ? "default" : "secondary"}>{saved ? "Saved" : "Draft"}</Badge>
          </Row>
          <Tabs id="settings-tabs" value={tab} onValueChange={value => { tab = value; }} items={[
            { value: "profile", label: "Profile", content: (
              <Column gap={20}>
                <Card title="Profile" description="Set the details visible to your team.">
                  <Column gap={6}>
                    <Text size={13} weight={500}>Display name</Text>
                    <TextInput id="display-name" value={name} placeholder="Your name" onChange={value => { name = value; saved = false; }} />
                  </Column>
                  <Checkbox id="updates" label="Send me product updates" checked={updates}
                    onCheckedChange={value => { updates = value; saved = false; }} />
                  <Switch id="notifications" label="Desktop notifications" checked={notifications}
                    onCheckedChange={value => { notifications = value; saved = false; }} />
                  <Separator />
                  <Row justify="between">
                    <Badge variant="outline">Local profile</Badge>
                    <Button id="save-form" onClick={() => { saved = true; }}>Save changes</Button>
                  </Row>
                </Card>
                <Card title="Audio" description="Adjust the notification volume.">
                  <Row gap={16}>
                    <Slider id="volume" label="Notification volume" value={volume} min={0} max={100} step={5}
                      onValueChange={value => { volume = value; saved = false; }} style={{ flex: 1, width: "auto" }} />
                    <Text id="volume-value" weight={600}>{volume}%</Text>
                  </Row>
                  <Progress id="volume-progress" value={volume} label="Volume level" />
                </Card>
              </Column>
            ) },
            { value: "billing", label: "Billing", content: (
              <Card title="Plan" description="Choose the workspace plan.">
                <RadioGroup id="plan" value={plan} options={[
                  { value: "personal", label: "Personal" },
                  { value: "team", label: "Team" },
                  { value: "enterprise", label: "Enterprise", disabled: true },
                ]} onValueChange={value => { plan = value; saved = false; }} />
                <Text id="selected-plan" color={c.mutedForeground}>Selected: {plan}</Text>
              </Card>
            ) },
          ]} />
          <Card title="Help" description="Common questions about these settings.">
            <Accordion id="help" value={section} onValueChange={value => { section = value; }} items={[
              { value: "details", title: "Where are my settings stored?", content:
                <Text color={c.mutedForeground}>This example keeps values in memory while the app is open.</Text> },
              { value: "keyboard", title: "Can I use the keyboard?", content:
                <Text color={c.mutedForeground}>Use Tab to focus controls, Space to activate and arrow keys for the slider.</Text> },
            ]} />
          </Card>
        </Column>
      </Scroll>
    </Window>
  );
}
