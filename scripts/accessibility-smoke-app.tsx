/** @jsxImportSource ../packages/core/src */
import {
  Button,
  Column,
  DataGrid,
  Field,
  Input,
  Modal,
  NavigationMenu,
  Scroll,
  Select,
  Text,
  TextArea,
  View,
  Window,
  render,
} from "../packages/core/src/index";

let email = "initial@example.com";
let password = "topsecret";
let notes = "First line\nabc אבג";
let selectOpen = true;
let selectValue = "alpha";
let navigationValue = "overview";
let gridSelection: Array<string | number> = ["alpha"];
let dialogOpen = false;
let dialogValue = "dialog value";

const gridRows = [
  { id: "alpha", name: "Alpha row" },
  { id: "beta", name: "Beta row" },
];

function App() {
  return (
    <Window title="Tarve Accessibility Smoke" width={760} height={860} minWidth={640} minHeight={560} position="center">
      <Column padding={24} gap={16} style={{ width: "100%", height: "100%" }}>
        <Text size={24} weight={700}>Accessibility smoke</Text>

        <Field id="a11y-email-field" label="Email address" error="Email validation message" required>
          <Input id="a11y-email" type="email" value={email} onChange={(value) => { email = value; }} />
        </Field>

        <Field id="a11y-password-field" label="Password" description="Password must stay private." required>
          <Input id="a11y-password" type="password" value={password} onChange={(value) => { password = value; }} />
        </Field>

        <Field id="a11y-notes-field" label="Notes" description="Multiline bidirectional text." required>
          <TextArea id="a11y-notes" value={notes} onChange={(value) => { notes = value; }} style={{ height: 110 }} />
        </Field>

        <Button id="a11y-open-dialog" onClick={() => { dialogOpen = true; }}>
          Open accessibility dialog
        </Button>

        <NavigationMenu
          id="a11y-navigation"
          value={navigationValue}
          items={[
            { value: "overview", label: "Overview nav" },
            { value: "settings", label: "Settings nav" },
          ]}
          onValueChange={(value) => { navigationValue = value; }}
        />

        <Select
          id="a11y-select"
          open={selectOpen}
          value={selectValue}
          options={[
            { value: "alpha", label: "Alpha option" },
            { value: "beta", label: "Beta option" },
          ]}
          onOpenChange={(open) => { selectOpen = open; }}
          onValueChange={(value) => { selectValue = value; }}
        />

        <DataGrid
          id="a11y-grid"
          columns={[{ key: "name", header: "Name" }]}
          rows={gridRows}
          rowKey={(row) => row.id}
          height={110}
          rowHeight={34}
          selectionMode="single"
          selectedKeys={gridSelection}
          onSelectionChange={(keys) => { gridSelection = keys; }}
        />

        <Scroll id="a11y-scroll" style={{ width: "100%", height: 110 }}>
          <Column gap={8} style={{ width: "100%" }}>
            <Text>Scrollable accessibility region</Text>
            <View style={{ height: 260 }} />
            <Button id="a11y-scroll-target">Bring me into view</Button>
          </Column>
        </Scroll>
      </Column>

      <Modal
        id="a11y-dialog"
        open={dialogOpen}
        title="Accessibility dialog"
        description="Modal UIA scope"
        showClose={false}
        onOpenChange={(open) => { dialogOpen = open; }}
      >
        <Column gap={12}>
          <Field id="a11y-dialog-field" label="Dialog value" description="Editable inside the modal.">
            <Input id="a11y-dialog-input" value={dialogValue} onChange={(value) => { dialogValue = value; }} />
          </Field>
          <Button id="a11y-dialog-close" onClick={() => { dialogOpen = false; }}>Close dialog</Button>
        </Column>
      </Modal>
    </Window>
  );
}

await render(App);
