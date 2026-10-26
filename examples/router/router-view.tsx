// The router example's view: two tabs (people, settings), each with its own stack.
// router.tsx runs it; scripts/smoke-runtime-parity.ts drives it on every runtime.
import { Button, Card, Column, Row, Text, TitleBar, Window } from "@tarve/core";
import { Link, TabRouterView, createTabRouter, route, useRoute, type Route, type ScreenProps } from "@tarve/router";

interface Person { id: string; name: string; role: string }
const people: Person[] = [
  { id: "1", name: "Ada Lovelace", role: "Analyst" },
  { id: "2", name: "Alan Turing", role: "Codebreaker" },
  { id: "3", name: "Grace Hopper", role: "Compiler pioneer" },
];

function PeopleList() {
  return (
    <Column gap={10} padding={20}>
      <Text size={20} weight={600}>People</Text>
      {people.map(person => (
        <Link key={person.id} to={`/people/${person.id}`}>{person.name}</Link>
      ))}
      <Link to="/people/42">A person that does not exist</Link>
    </Column>
  );
}

/** Reads the route with useRoute(): no prop drilling for deep components. */
function Breadcrumb() {
  const current = useRoute<Route<"person", { id: string }>>();
  return <Text size={12} color="#71717a">{current.path}</Text>;
}

function PersonScreen({ params, router }: ScreenProps<{ id: string }>) {
  const person = people.find(candidate => candidate.id === params.id);
  const next = people[(people.findIndex(candidate => candidate.id === params.id) + 1) % people.length]!;
  return (
    <Column gap={12} padding={20}>
      <Breadcrumb />
      <Card>
        <Column gap={6} padding={16}>
          <Text size={20} weight={600}>{person?.name ?? "Unknown person"}</Text>
          <Text>{person?.role ?? `No one has the id ${params.id}.`}</Text>
        </Column>
      </Card>
      <Row gap={8}>
        <Button variant="outline" onClick={() => router.pop()}>Back</Button>
        <Button onClick={() => router.push("person", { id: next.id })}>Next: {next.name}</Button>
        <Button variant="outline" onClick={() => router.popToRoot()}>All people</Button>
      </Row>
      <Text size={12} color="#71717a">Escape, Alt+Left or the mouse back button also go back.</Text>
    </Column>
  );
}

function SettingsScreen() {
  return (
    <Column gap={10} padding={20}>
      <Text size={20} weight={600}>Settings</Text>
      <Link to="/settings/about">About this example</Link>
      <Link to="/people/3">Jump to Grace Hopper (switches tab)</Link>
    </Column>
  );
}

function AboutScreen() {
  return (
    <Column gap={10} padding={20}>
      <Text size={20} weight={600}>About</Text>
      <Text>Each tab keeps its own stack: switch tabs and come back.</Text>
    </Column>
  );
}

export const tabs = createTabRouter({
  transition: "slide",
  tabs: {
    people: {
      title: "People",
      routes: {
        people: route("/", PeopleList),
        person: route("/people/:id", PersonScreen, { title: r => people.find(p => p.id === r.params.id)?.name ?? "Person" }),
      },
    },
    settings: {
      title: "Settings",
      routes: {
        settings: route("/settings", SettingsScreen),
        about: route("/settings/about", AboutScreen, { title: "About" }),
      },
    },
  },
});

export function App() {
  const stack = tabs.current;
  return (
    <Window title="Router" width={560} height={480} minWidth={360} minHeight={360} onCloseRequest={tabs.onCloseRequest}>
      <TitleBar
        title={stack.title() ?? tabs.title(tabs.active)}
        {...(tabs.current.canGoBack() ? { onBack: () => tabs.back() } : {})}
      />
      <TabRouterView router={tabs} />
    </Window>
  );
}
