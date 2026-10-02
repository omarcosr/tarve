import { Accordion, Text } from "@tarve/core";

let open: string | undefined = "renderers";

<Accordion
  value={open}
  items={[
    { value: "renderers", title: "Which renderers are there?", content: <Text>D3D11, Vello/WGPU and a CPU path.</Text> },
    { value: "platforms", title: "Which platforms?", content: <Text>Windows x64 and Linux x64.</Text> },
  ]}
  onValueChange={(value) => {
    open = value;
  }}
/>;
