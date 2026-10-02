import { Scroll, Text } from "@tarve/core";

let offset = 0;

<Scroll
  gap={8}
  padding={12}
  style={{ height: 240 }}
  onScroll={(next) => {
    offset = next;
  }}
>
  {Array.from({ length: 50 }, (_, index) => (
    <Text key={index}>Row {index + 1}</Text>
  ))}
</Scroll>;
