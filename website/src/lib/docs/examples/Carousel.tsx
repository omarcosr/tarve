import { Carousel, Text } from "@tarve/core";

let index = 0;

<Carousel
  index={index}
  loop
  items={[
    { value: "one", content: <Text size={32}>One</Text> },
    { value: "two", content: <Text size={32}>Two</Text> },
    { value: "three", content: <Text size={32}>Three</Text> },
  ]}
  onIndexChange={(next) => {
    index = next;
  }}
/>;
