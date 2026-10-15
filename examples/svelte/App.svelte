<script lang="ts">
  import { TitleBar } from "@tarve/svelte";
  import TodoItem from "./TodoItem.svelte";

  type Todo = { id: number; text: string; done: boolean };

  let todos = $state<Todo[]>([
    { id: 1, text: "Compile .svelte with @tarve/svelte", done: true },
    { id: 2, text: "Render it in a native window", done: false },
  ]);
  let draft = $state("");
  let filter = $state<"all" | "open" | "done">("all");
  let nextId = 3;
  const filters = ["all", "open", "done"] as const;

  let visible = $derived(todos.filter(todo => filter === "all" || (filter === "done") === todo.done));
  let remaining = $derived(todos.filter(todo => !todo.done).length);

  function add() {
    const text = draft.trim();
    if (!text) return;
    todos.push({ id: nextId++, text, done: false });
    draft = "";
  }

  function remove(id: number) {
    todos = todos.filter(todo => todo.id !== id);
  }
</script>

<svelte:head><title>Svelte todos · {remaining} left</title></svelte:head>
<TitleBar showMaximize={false}>
  <span>{remaining} left</span>
</TitleBar>

<main class="app">
  <div drag-region>drag here</div>
  <h1>Todos</h1>
  <p class="text-gray-500 text-sm">Svelte 5 runes, compiled ahead of time, drawn natively by Tarve.</p>

  <form class="add" onsubmit={event => { event.preventDefault(); add(); }}>
    <input id="draft" class="flex-1" bind:value={draft} placeholder="What needs doing?" />
    <button id="add" type="submit" disabled={!draft.trim()}>Add</button>
  </form>

  <div class="filters">
    {#each filters as option}
      <button id={`filter-${option}`} class="filter" class:active={filter === option} onclick={() => (filter = option)}>{option}</button>
    {/each}
  </div>

  <div class="list">
    {#each visible as todo (todo.id)}
      <TodoItem bind:done={todo.done} text={todo.text} onremove={() => remove(todo.id)} />
    {:else}
      <p class="empty">Nothing here.</p>
    {/each}
  </div>

  <p id="footer" class="footer">{remaining} of {todos.length} open</p>
</main>

<style>
  .app { padding: 24px; gap: 12px; }
  .add { flex-direction: row; gap: 8px; }
  .filters { flex-direction: row; gap: 6px; }
  .filter { padding: 4px 10px; }
  .active { background-color: #2563eb; color: #ffffff; }
  .list { gap: 4px; }
  .empty { color: #6b7280; }
  .footer { font-size: 12px; color: #6b7280; }
</style>
