/** First-document JSON: plain, or with a style table (each style object written once). */
import { Button, Column, Row, Scroll, Text, Window } from "@tarve/core";
import { compileTree } from "../../packages/core/src/reconciler";

const view = <Window title="b" width={1024} height={760}><Column flex={1}><Scroll id="list" flex={1}><Column>
  {Array.from({ length: 2000 }, (_, i) => <Row key={i} style={{ height: 36, shrink: 0 }} gap={12}><Text style={{ flex: 1 }}>Record {i}: native layout and text 1</Text><Button size="sm">Open</Button></Row>)}
</Column></Scroll></Column></Window>;
const doc = compileTree(view, false, "auto", [], {}, true, { width: 1024, height: 760 }).document;

function withTable(document: object): string {
  const index = new Map<object, number>();
  const styles: object[] = [];
  const json = JSON.stringify(document, (key, value) => {
    if (key !== "style" || value === null || typeof value !== "object") return value;
    let at = index.get(value);
    if (at === undefined) { at = styles.length; styles.push(value); index.set(value, at); }
    return at;
  });
  return '{"styles":' + JSON.stringify(styles) + "," + json.slice(1);
}
const time = (f: () => string) => { const v: number[] = []; let size = 0; for (let i = 0; i < 15; i++) { const t = performance.now(); size = f().length; v.push(performance.now() - t); } return [v.sort((a, b) => a - b)[7]!.toFixed(2), size]; };
console.log(JSON.stringify({ plain: time(() => JSON.stringify(doc)), table: time(() => withTable(doc)) }));
