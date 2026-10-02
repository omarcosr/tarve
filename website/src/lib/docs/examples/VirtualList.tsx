import { Row, Text, VirtualList } from "@tarve/core";

const records = Array.from({ length: 100_000 }, (_, index) => ({ id: index, name: `Record ${index}` }));
let offset = 0;

<VirtualList
  id="records"
  items={records}
  itemHeight={36}
  height={480}
  offset={offset}
  keyForItem={(record) => record.id}
  onScroll={(next) => {
    offset = next;
  }}
  renderItem={(record) => (
    <Row padding={8}>
      <Text>{record.name}</Text>
    </Row>
  )}
/>;
