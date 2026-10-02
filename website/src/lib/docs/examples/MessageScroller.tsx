import { Bubble, MessageScroller, Text } from "@tarve/core";

<MessageScroller height={360} gap={12}>
  {Array.from({ length: 20 }, (_, index) => (
    <Bubble key={index} side={index % 2 ? "outgoing" : "incoming"}>
      <Text>Message {index + 1}</Text>
    </Bubble>
  ))}
</MessageScroller>;
