import { Glass, Icon, Text, View } from "@tarve/core";

<View style={{ width: 420, height: 200, radius: 18, padding: 24, justify: "end", background: "linear-gradient(135deg, #ff2d55, #af52de 50%, #007aff)" }}>
  <Glass radius={26} style={{ height: 52, padding: { left: 18, right: 18 }, direction: "row", align: "center", gap: 10 }}>
    <Icon name="play" size={18} color="#1c1c1ecc" />
    <Text size={15} weight={600} color="#1c1c1e">Now playing</Text>
  </Glass>
</View>;
