import { createApp, Window, Button, Dialog, Row, View } from "@tarve/core";
let open = false;

function App() {
  return (
    <Window title="Dialog" width={480} height={320}>
      <View padding={16}>
        <Button onClick={() => { open = true; }}>Open dialog</Button>
        <Dialog
          open={open}
          onOpenChange={value => { open = value; }}
          title="A native dialog"
          description="Escape, the close button or the overlay dismiss it."
          footer={<Row justify="end"><Button onClick={() => { open = false; }}>OK</Button></Row>}
        />
      </View>
    </Window>
  );
}

createApp(App);
