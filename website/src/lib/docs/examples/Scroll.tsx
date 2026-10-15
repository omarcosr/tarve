import { Scroll, Text } from "@tarve/core";

<Scroll
  gap={8}
  padding={12}
  style={{ height: 240 }}
  onScroll={(offset) => console.log("scrolled to", offset)}
>
  {Array.from({ length: 50 }, (_, index) => (
    <Text key={index}>Row {index + 1}</Text>
  ))}
</Scroll>;
