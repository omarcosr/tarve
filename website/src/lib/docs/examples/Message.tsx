import { Button, Message, Text } from "@tarve/core";

<Message
  side="incoming"
  author="Assistant"
  avatarFallback="AI"
  timestamp="10:42"
  actions={<Button variant="ghost" size="sm">Copy</Button>}
>
  <Text>Your build finished in 2.4s.</Text>
</Message>;
