import { Carousel, Column, Text } from "@tarve/core";

let index = 0;

const slide = (title: string, background: string) => (
  <Column align="center" justify="center" style={{ width: 280, height: 160, radius: 12, background }}>
    <Text size={28} weight={700}>{title}</Text>
  </Column>
);

<Carousel
  index={index}
  loop
  items={[
    { value: "one", content: slide("One", "#4c1d95") },
    { value: "two", content: slide("Two", "#155e75") },
    { value: "three", content: slide("Three", "#9a3412") },
  ]}
  onIndexChange={(next) => {
    index = next;
  }}
/>;
