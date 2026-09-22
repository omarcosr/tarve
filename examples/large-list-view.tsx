import { Badge, Button, Column, Row, Text, TitleBar, VirtualList, Window, theme } from "tarve";

const c = theme.colors;
export const records = Array.from(
  { length: 50_000 },
  (_, index) => `Record ${String(index + 1).padStart(5, "0")}`,
);
export const itemHeight = 56;
let offset = 0;
let opened = "None";

export function App() {
  return (
    <Window width={920} height={760} minWidth={680} minHeight={520}>
      <TitleBar title="Records" />
      <Column gap={16} padding={24} flex={1}>
        <Row justify="between">
          <Column gap={4}>
            <Text size={24} weight={650}>
              Records
            </Text>
            <Text color={c.mutedForeground}>{records.length.toLocaleString()} records with fixed-height virtual rows.</Text>
          </Column>
          <Badge variant="secondary">{records.length.toLocaleString()} items</Badge>
        </Row>
        <Text id="visible-range" size={12} color={c.mutedForeground}>
          First visible row: {Math.floor(offset / itemHeight) + 1} · Opened: {opened}
        </Text>
        <VirtualList
          id="records"
          items={records}
          itemHeight={itemHeight}
          height={600}
          offset={offset}
          keyForItem={(_, index) => index}
          onScroll={(next) => {
            offset = next;
          }}
          renderItem={(record, index) => (
            <Row
              gap={12}
              justify="between"
              align="center"
              style={{
                width: "100%",
                padding: 10,
                borderWidth: { bottom: 1 },
                borderColor: c.border,
              }}
            >
              <Text id={`record-${index}`} size={13}>
                {record}
              </Text>
              <Button
                id={`open-${index}`}
                size="sm"
                variant="default"
                onClick={() => {
                  opened = record;
                }}
              >
                Open
              </Button>
            </Row>
          )}
        />
      </Column>
    </Window>
  );
}
