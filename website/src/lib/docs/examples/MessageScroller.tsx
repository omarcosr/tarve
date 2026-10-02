import { Message, MessageScroller, Text } from "@tarve/core";

<MessageScroller height={360} gap={12} style={{ width: 420 }}>
  {Array.from({ length: 20 }, (_, index) => (
    <Message key={index} side={index % 2 ? "outgoing" : "incoming"}>
      <Text>{index % 2 ? `Reply ${(index + 1) / 2}` : `Message ${index / 2 + 1}`}</Text>
    </Message>
  ))}
</MessageScroller>;
