import { List, Text } from "@tarve/core";

const tasks = ["Write docs", "Ship v0.4", "Celebrate"];

<List
  items={tasks}
  gap={8}
  keyForItem={(task) => task}
  renderItem={(task, index) => <Text>{index + 1}. {task}</Text>}
/>;
