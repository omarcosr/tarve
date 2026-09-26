# Tarve

GUI nativa para **Bun + TypeScript/TSX**, com **Taffy** (Flex/Grid), **Parley** (shaping, medição e quebra de texto) e renderer selecionável. No Windows, o backend GPU padrão é **D3D11 + DXGI nativo**; **Vello/WGPU** permanece como fallback/escape hatch, e **vello_cpu + softbuffer** oferece o caminho de menor consumo de memória. Janela Win32 via Winit. O tema padrão usa a linguagem visual shadcn: zinc, superfícies claras, bordas discretas, raios de 6–12 px e Segoe UI.

Licenciado sob a **Apache License 2.0**. Consulte [`LICENSE`](LICENSE).

## Rodar no Windows

Pré-requisitos para desenvolver o Tarve: Bun 1.4+, Rust estável com target `x86_64-pc-windows-msvc` e Visual Studio Build Tools com C++/Windows SDK. O renderer GPU padrão no Windows exige D3D11 feature level 11.0; o renderer legado Vello/WGPU pode usar DirectX 12 ou Vulkan. O renderer CPU não exige compute shaders.

```powershell
cd A:\tarve
bun install
bun run dev
```

`dev` gera o pacote npm local, instala o tarball nos exemplos e reinicia o app ao editar TS/TSX. Após editar o Tarve ou o backend Rust, reinicie `dev` para gerar e instalar um pacote atualizado. Para abrir o exemplo usando o último tarball instalado: `bun run start`.

### Renderer de baixo consumo de memória

O backend GPU continua sendo o padrão. A forma recomendada de escolher o renderer é na própria criação do app:

```tsx
const app = createApp(App, {
  renderer: "cpu",
});
```

`renderer` aceita `"cpu"`, `"gpu"` ou `"auto"`. `"cpu"` usa `vello_cpu + softbuffer`. No Windows, `"gpu"` usa o backend nativo D3D11/DXGI por padrão e cai para Vello/WGPU sobre DX12 se a inicialização D3D11 falhar; fora do Windows, o caminho GPU permanece Vello/WGPU. `"auto"` é o padrão e seleciona GPU salvo quando `TARVE_RENDERER` é usado como override de desenvolvimento/CI.

Uma escolha explícita no app tem prioridade sobre o ambiente. Por exemplo, `renderer: "cpu"` continua CPU mesmo se `TARVE_RENDERER=gpu`. O env permanece disponível para testar apps que usam `renderer: "auto"`:

```powershell
$env:TARVE_RENDERER="cpu"
bun examples/counter.tsx
```

No env também são aceitos `software` e `softbuffer` como aliases de `cpu`. Um valor desconhecido falha explicitamente quando o app está em `"auto"`; uma escolha explícita `"cpu"`/`"gpu"` não depende do valor do env.

`WGPU_BACKEND` continua disponível como escape hatch de desenvolvimento. No Windows, defini-lo força o backend legado Vello/WGPU em vez do D3D11 nativo, por exemplo `$env:WGPU_BACKEND="dx12"`. Isso é útil para comparação e diagnóstico; não é necessário no uso normal.

## Usar como pacote npm

O pacote para Windows x64 inclui a DLL em release; quem instala precisa somente do Bun. O renderer GPU exige driver compatível; o renderer CPU não exige compute shaders. A publicação no registry ainda é uma etapa separada. Para gerar e instalar o artefato local:

A política oficial de licença, versionamento, Authenticode e release está em [`RELEASE.md`](RELEASE.md). Releases assinados usam tags `v<semver>`; o npm registry continua fora do workflow automático até a política de distribuição pública ser definida explicitamente.

```powershell
# No repositório Tarve:
bun run pack
bun run smoke:package

# Em outro projeto Bun:
bun add A:/tarve/dist/tarve-0.1.0.tgz
bun add -d typescript @types/bun
bun app.tsx
bun run tarve build app.tsx --outfile dist/MeuApp.exe
```

Configure `tsconfig.json` com `"jsx": "react-jsx"`, `"jsxImportSource": "tarve"`, `"moduleResolution": "Bundler"` e `"types": ["bun", "tarve/assets"]`. A API pública é importada de `tarve`; o build também está disponível como `import { build } from "tarve/build"`.

`examples/counter.tsx` mostra o app mínimo, `examples/basic.tsx` reúne os componentes iniciais, `examples/forms.tsx` demonstra controles de formulário, `examples/large-list.tsx` mostra registros com lista virtual e `examples/rich-content.tsx` reúne Markdown, código destacado e diff nativo longo. Exemplos usam a mesma API instalada, sem configurar manualmente a DLL. Eventos nativos ficam em uma fila FIFO na DLL; um named pipe do Windows acorda o event loop apenas quando a fila passa de vazia para não vazia, e o runtime Bun principal então a drena com `tarve_poll_event()` não bloqueante. Não há um segundo Bun Worker dedicado ao pump de eventos.

`examples/` é um projeto Bun consumidor: tem `package.json` e `tsconfig.json` próprios e importa somente a API pública. Após publicar `tarve@0.1.0` no registry, instale o pacote:

```powershell
cd A:\tarve\examples
bun add tarve@0.1.0
bun run check
bun run counter
bun run basic
bun run forms
bun run large-list
bun run tarve build counter.tsx --outfile dist/Counter.exe
bun run tarve build basic.tsx --outfile dist/Basic.exe
```

Antes da publicação, `bun run smoke:package` copia os exemplos para uma pasta temporária fora do repositório, instala o tarball npm local, verifica o `tsconfig.json` independente e compila os sete `.exe` com o CLI instalado, incluindo `RichContent.exe`. Para trabalhar na árvore de desenvolvimento, `bun run setup:examples` instala esse tarball em `examples/node_modules` sem registrar um caminho local no manifesto. Uma cópia própria dos exemplos pode instalar `A:/tarve/dist/tarve-0.1.0.tgz` com `bun add`; o código continua igual.

### Modal / Dialog

`Modal` segue o visual padrão do shadcn e também é exportado como `Dialog`. Ele usa overlay nativo, posicionamento absoluto, focus trap, bloqueio de scroll do conteúdo de fundo e dismiss por `Escape`, backdrop ou botão de fechar.

```tsx
let open = false;

<Button onClick={() => { open = true; }}>Open dialog</Button>
<Modal
  open={open}
  onOpenChange={(value) => { open = value; }}
  title="Create project"
  description="Start a new project in your workspace."
  footer={<Button onClick={() => { open = false; }}>Create project</Button>}
>
  <Input placeholder="Project name" />
</Modal>
```

### Controles de aplicação

`Input`, `Checkbox`, `Switch`, `RadioGroup`, `Select`, `Slider`, `TextArea`, `Card`, `Badge`, `Separator`, `Progress`, `Tabs` e `Accordion` estão disponíveis em `tarve`. Os controles de seleção recebem o valor atual e notificam alterações por callback; o app guarda esse valor em seu estado. `Pressable`, `Svg`, `Icon` e `Portal` permitem compor controles próprios. Consulte `examples/forms-view.tsx` para um formulário com clique, foco e teclado.

O kit também inclui `Tooltip`, `Popover`, `DropdownMenu`, `ContextMenu`, `Combobox`, `Command`, `CommandPalette`, `AlertDialog`, `Sheet`, `Toast`, `Toaster`, `Skeleton`, `Spinner`, `Avatar`, `Breadcrumb`, `Pagination`, `Collapsible`, `Table`, `DataTable`, `TreeView`, `DataGrid`, `Menubar`, `HoverCard`, `Calendar` e `DatePicker`. Popups usam a primitive nativa de portal: continuam ancorados pelo layout do trigger, mas escapam do clipping de `Scroll`, participam do hit-test acima do conteúdo normal e podem fechar por clique fora. Triggers interativos existentes são preservados em vez de embrulhados em outro controle; menus/combobox/command usam roving focus nativo com teclado. `ContextMenu` abre por clique direito nativo.

A camada de componentes também cobre `Alert`, `AspectRatio`, `ButtonGroup`, `Carousel`, `Chart`, `Drawer`, `Empty`, `Field`, `InputGroup`, `InputOTP`, `Item`, `Kbd`, `Label`, `NativeSelect`, `NavigationMenu`, `Resizable`, `Sidebar`, `Toggle`, `ToggleGroup`, `Typography`, `Direction`, `Questionnaire`, `Attachment`, `Bubble`, `Marker`, `Message` e `MessageScroller`. Eles usam as mesmas primitives e tokens do tema; `Resizable` usa um splitter nativo controlado com drag e teclado, e `Chart` renderiza barras com primitives existentes, sem dependência externa.

`Markdown`, `Code` e `Diff` são nós folha nativos para documentos grandes. `Markdown` recebe `source` e suporta sintaxe GFM (tabelas com alinhamento de células, cabeçalho e regras pintados nativamente, tarefas, links, listas, citações e blocos de código); HTML embutido aparece como texto literal. Links abrem a URI pelo sistema ou chamam `onLinkClick`. `Code` recebe `code`, `language` e opcionalmente `path` para destacar sintaxe com Syntect. Os três permitem seleção e cópia de conteúdo sem incluir gutters. `Diff` recebe um patch unificado/git em `source` ou `oldText` e `newText`; calcula o patch nativamente, destaca linhas e palavras alteradas e molda apenas as linhas visíveis dentro de `Scroll`. `collapsedPaths`, `maxLines`, `onToggleFile`, `onShowMore` e `onLineClick` controlam a interação sem criar nós extras. `onShowMore` recebe `(hiddenLines, path?)`; `onLineClick` recebe texto, caminho e números de linha da linha clicada. A prop `highlight` pode ser aplicada a um contêiner para buscar nas folhas `Text`, `Markdown`, `Code` e `Diff` descendentes, inclusive através de folhas adjacentes na mesma linha. `wholeWord` e `caseSensitive` refinam a busca; `activeIndex` destaca e revela a ocorrência ativa, `onHighlight` informa `matchCount` e `ranges` aceita offsets UTF-16 explícitos. `createTextSearchController` fornece `next`, `previous`, `goTo` e uma `props` pronta para o contêiner; `findRanges` calcula ranges UTF-16 para buscas locais. Os três usam Parley e o mesmo caminho de pintura nos renderers CPU, D3D11 e Vello. Execute `bun run smoke:rich-content` para validar automaticamente CPU, D3D11 e Vello/DX12.

Tabelas e blocos de código Markdown largos rolam horizontalmente com a roda do mouse sobre o bloco. A seleção, a busca e as posições de acessibilidade acompanham o deslocamento dentro do mesmo leaf.

```tsx
<Column highlight={{ query: search, activeIndex: currentMatch }} onHighlight={({ matchCount }) => setMatchCount(matchCount)}>
  <Markdown source={document} />
  <Code code={snippet} language="tsx" showLineNumbers />
  <Diff source={patch} maxLines={expanded ? undefined : 80} onShowMore={() => setExpanded(true)} />
</Column>
```

`List` e `VirtualList` são componentes distintos. `List` é a lista normal: mantém todos os itens montados, aceita alturas diferentes por item e pode receber `items`/`renderItem` ou `children`. `VirtualList` é a opção para coleções grandes: usa linhas de altura fixa e mantém na árvore nativa apenas a faixa visível mais o overscan.

```tsx
<List
  items={projects}
  keyForItem={(project) => project.id}
  renderItem={(project) => <Text>{project.name}</Text>}
/>

<VirtualList
  items={rows}
  itemHeight={36}
  height={360}
  offset={offset}
  onScroll={(next) => { offset = next; }}
  renderItem={(row) => <Text>{row.label}</Text>}
/>
```

`Select` segue o modelo controlado de valor (`value` + `onValueChange`) e suporta opções desabilitadas, placeholder, abertura controlada opcional e teclado. `Enter`/`Space` alternam o popup; setas, `Home` e `End` navegam entre opções habilitadas; `Escape` fecha. Listas longas ganham scroll e o popup é renderizado como portal nativo.

`Input` e `TextArea` usam edição nativa sobre Parley. `Input` aceita `type="text" | "password" | "email" | "number" | "search" | "tel" | "url"`; password é mascarado no renderer nativo sem expor a seleção ao clipboard, e number rejeita edições não numéricas. Ambos suportam caret por clique, seleção parcial por arraste ou `Shift` + setas/Home/End, `Ctrl+A/C/X/V` e deleção sobre a seleção; `TextArea` também faz wrap, navegação vertical e scroll interno mantendo o caret visível. `Scroll`/`ScrollArea` aceita `orientation="vertical" | "horizontal" | "both"` e `speed`, um multiplicador da roda/trackpad (`1` é o padrão, `0.5` reduz pela metade e `2` dobra a velocidade). `onScroll` permanece compatível com o offset escalar do eixo principal e `onScrollPosition` expõe `{ x, y, maxX, maxY }`.

```tsx
<Input type="email" value={email} onChange={setEmail} />
<Input type="password" value={password} onChange={setPassword} />
<Input type="number" value={quantity} onChange={setQuantity} />
```

```tsx
<Popover id="account" open={open} trigger={<Text>Account</Text>} onOpenChange={setOpen}>
  <Text>Profile</Text>
</Popover>

<ContextMenu
  id="file-menu"
  open={menuOpen}
  trigger={<Text>Right click me</Text>}
  onOpenChange={setMenuOpen}
  items={[{ value: "rename", label: "Rename" }, { value: "delete", label: "Delete" }]}
/>

<DatePicker
  id="due-date"
  open={dateOpen}
  month={month}
  value={date}
  onOpenChange={setDateOpen}
  onMonthChange={setMonth}
  onValueChange={setDate}
/>
```

`TreeView` usa estado controlado para expansão/seleção e navegação vertical por teclado. `DataGrid` é separado do `DataTable`: suporta virtualização de linhas, sorting/filtering local ou manual, seleção controlada e ativação por teclado.

Para integrações de desktop que não são componentes visuais, use o `AppHandle` retornado por `createApp`:

```tsx
const app = createApp(App);

const unregisterSave = app.registerHotkey("Ctrl+S", () => save());

const file = await app.openFileDialog({
  title: "Open project",
  filters: [{ name: "JSON", extensions: ["json"] }],
});

const files = await app.openFilesDialog();
const folder = await app.openFolderDialog();
const target = await app.saveFileDialog({ fileName: "report.json" });
```

Hotkeys aceitam aliases comuns (`Control`, `Cmd`, `Option`, `Esc`) e são normalizados para uma representação canônica como `Ctrl+Shift+S`. Os file dialogs usam a UI nativa do Windows e retornam `undefined`/`[]` quando o usuário cancela.

`createApp` também oferece um boundary global de erros estruturados. Falhas recuperáveis de render/update, callbacks, listeners, hotkeys, bridge e dialogs são contidas e encaminhadas para `onError`; uma atualização que falha mantém a última árvore confirmada no native. Falha de render ou de inicialização antes do primeiro `ready` rejeita `app.ready` e encerra o handle sem criar uma janela parcialmente válida.

```tsx
const app = createApp(App, {
  onError(event) {
    console.error(event.source, event.event, event.targetId, event.error);
  },
});

await app.ready;
```

`AppErrorEvent.source` distingue `render`, `event-handler`, `listener`, `hotkey`, `bridge`, `native`, `request` e `file-dialog`. O próprio `onError` é isolado: se ele lançar, Tarve faz fallback para `console.error` sem derrubar o dispatcher.

### Custom title bar

`TitleBar` is declarative: simply render it inside `Window`. Tarve resolves the component tree before creating the native window, detects the title bar, and automatically selects custom window chrome. Without `TitleBar`, the operating-system title bar remains native. On Windows 11 Tarve asks DWM to keep the native rounded window corners and compositor border while the title bar remains fully custom. The root also draws a 1 px shadcn/zinc border with an 8 px radius as a visual fallback. When maximized/fullscreen, both borders and the corner radius are suppressed and restored when the window returns to its normal state. Native drag, minimize/maximize/close and the 6 px resize hit area remain available.

```tsx
<Window title="My app" width={1000} height={700}>
  <TitleBar title="My app" />
  <View flex={1}>{/* app */}</View>
</Window>
```

`TitleBar` accepts normal `style` overrides and custom `children`, plus `showMinimize`, `showMaximize`, `showClose` and `height`. Double-clicking its draggable area toggles maximize/restore.

`Window.position` configures the initial window position before the first visible frame. The default is `"center"`. Presets anchor to the monitor's usable work area (excluding the Windows taskbar). You can also use one of the other anchors (`"top-left"`, `"top"`, `"top-right"`, `"left"`, `"right"`, `"bottom-left"`, `"bottom"`, `"bottom-right"`) or provide logical desktop coordinates. Negative coordinates are valid for monitors positioned to the left or above the primary display.

`Window.onCloseRequest` intercepta o botão fechar do Windows e o botão close de uma `TitleBar` customizada. Chame `event.preventDefault()` para cancelar a tentativa; `app.close()` continua sendo fechamento programático incondicional.

```tsx
<Window onCloseRequest={(event) => {
  if (hasUnsavedChanges) event.preventDefault();
}}>
  {/* ... */}
</Window>
```

```tsx
<Window title="Centered" width={900} height={640} position="center">
  {/* ... */}
</Window>

<Window title="Bottom right" position="bottom-right">
  {/* ... */}
</Window>

<Window title="Exact position" position={{ x: 120, y: 80 }}>
  {/* ... */}
</Window>
```

`position` is an initial creation option; changing it after the native window has been created does not move an existing window.

### Light, dark and custom themes

Tarve components use semantic shadcn-style color tokens. `Window` resolves those tokens against `lightTheme` by default, or against the theme you pass. Switching the `theme` prop at runtime repaints the existing native window; it does not recreate the HWND.

```tsx
import { Window, darkTheme, lightTheme } from "tarve";

let dark = true;

<Window theme={dark ? darkTheme : lightTheme}>
  {/* every Tarve component follows the selected palette */}
</Window>
```

Create a branded theme by inheriting either built-in palette and overriding only the semantic colors you need:

```tsx
import { createTheme, darkTheme, theme } from "tarve";

const midnight = createTheme({
  colors: {
    primary: "#8b5cf6",
    primaryHover: "#7c3aed",
    border: "#3f3f46",
  },
}, darkTheme);

<Window theme={midnight}>
  <View style={{ background: theme.colors.card, borderColor: theme.colors.border }} />
</Window>
```

`theme.colors.*` values are semantic references, so application styles using them automatically follow the active palette. Literal colors such as `#ff00aa` remain literal and are never rewritten. Inputs, selection, caret, scrollbar, modal overlay, disabled states and titlebar controls all use the same palette.

The default focus outline is also part of the active theme. `focusOutline` is applied to every focusable native control, while a component's own `style.focus` overrides only the fields it specifies. Prefer `Theme.create(base, overrides)` when deriving from a light/dark theme:

```tsx
import { Theme, darkTheme, lightTheme } from "tarve";

const appTheme = Theme.create(darkMode ? darkTheme : lightTheme, {
  focusOutline: {
    outlineWidth: 1,
    outlineOffset: 1,
    outlineRadius: 6,
    outlineStyle: "dashed",
    outlineColor: "#8b5cf6",
  },
});

<Window theme={appTheme}>
  <Button>Uses the theme outline</Button>
  <Button style={{ focus: { outlineWidth: 3 } }}>Overrides only the width</Button>
</Window>
```

To disable the default focus outline for an entire theme, set its width to zero:

```tsx
const noFocusOutline = createTheme({
  focusOutline: { outlineWidth: 0 },
});
```

`Style.create()` is available separately for typed reusable style declarations, and `Style.merge()` preserves nested interactive states instead of replacing the whole `focus`/`hover` object:

```tsx
const styles = Style.create({
  button: {
    height: 36,
    focus: { outlineWidth: 2 },
  },
});

const noOutline = Style.merge(styles.button, {
  focus: { outlineWidth: 0, outlineStyle: "none" },
});
```

Text selection can be controlled with the CSS-like `userSelect` style:

```tsx
<Text style={{ userSelect: "text" }}>Drag to select part of this text.</Text>
<Text style={{ userSelect: "all" }}>Any selection selects this whole element.</Text>
<View style={{ userSelect: "none" }}>
  <Text>This subtree is not selectable unless a child explicitly overrides it.</Text>
</View>
```

Supported values are `auto`, `text`, `none` and `all`. Tarve defaults normal UI text and chrome to `none`, matching native-app behavior where labels are not selectable. Editable `Input` and `TextArea` controls remain text-selectable by default. `auto` follows the nearest explicit ancestor selection mode; without one, it resolves to the native default for that node kind. Use `text` to opt normal UI text into partial selection, or `all` to make a subtree select atomically. `Button` and `Pressable` also serialize `none` explicitly so dragging labels does not interfere with normal control activation.

Links use the platform's registered handler and expose native hyperlink accessibility semantics. The component API is:

```tsx
import { Link } from "tarve";

<Link href="https://example.com/docs">Documentation</Link>
<Link href="mailto:hello@example.com">Email support</Link>
```

The HTML-like intrinsic delegates to the same `Link` implementation:

```tsx
<a href="https://example.com/docs">Documentation</a>
<a href="mailto:hello@example.com">Email support</a>
```

`Link`/`<a>` are focusable, activate with Enter, use the pointer cursor and default to an underline. Space does not activate links. Composed children are supported; Tarve derives the accessibility label from descendant text, or you can provide `label` on `Link` / `ariaLabel` on `<a>`. The same OS integration is available imperatively with `openExternal("https://example.com")`.

`Link` and HTML-like intrinsics accept CSS-like `color` / `backgroundColor` aliases both at the base style and inside visual states. For links, the resolved foreground is inherited by nested text so hover colors work with composed children too:

```tsx
<Link
  href="https://example.com/docs"
  style={{
    color: "#2563eb",
    hover: { color: "#1d4ed8" },
  }}
>
  <Row gap={6}><Text>Documentation</Text></Row>
</Link>
```

Text decoration is paint-only and supports `none`, `underline`, `overline` and `line-through`:

```tsx
<Text style={{ textDecoration: "underline" }}>Underlined</Text>
<Text style={{ textDecoration: "line-through" }}>Removed</Text>
```

Decorations propagate through descendant text, so setting `textDecoration` on a link/container also decorates nested text without affecting Taffy layout or Parley shaping.

Interactive controls use input-modality-aware focus styling. `focus` applies whenever a control owns focus, while `focusVisible` applies only when the focus indicator should be shown (for example after Tab/keyboard or accessibility focus). The theme's default focus ring uses `focusVisible`, so clicking a `Link`, `Button` or `Pressable` does not leave a keyboard-style outline behind:

```tsx
<Button style={{
  focus: { background: theme.colors.muted },
  focusVisible: { outlineWidth: 3 },
}}>
  Save
</Button>
```

Existing outline overrides inside `focus` remain compatible: Tarve also applies those outline fields to the generated `focusVisible` ring unless an explicit `focusVisible` override is provided.

Borders can use one width for every side or independent widths, using the same inset shape as `padding` and `margin`:

```tsx
<View style={{ borderWidth: 1, borderColor: theme.colors.border }} />

<View style={{
  borderWidth: { top: 1, right: 2, bottom: 4, left: 0 },
  borderColor: theme.colors.border,
}} />
```

Per-side border widths participate in Taffy layout as well as Vello painting, so child content is inset by the corresponding side rather than treating the border as a purely visual stroke.

`outline` is separate from `border`: it paints outside the component and never consumes Taffy layout space. Width, color, offset and radius are independently configurable:

```tsx
<Button
  style={{
    outlineWidth: 2,
    outlineColor: theme.colors.ring,
    outlineOffset: 2,
    outlineRadius: 10,
    outlineStyle: "dashed",
  }}
>
  Save
</Button>
```

`outlineStyle` supports `dotted`, `dashed`, `solid`, `double`, `groove`, `ridge`, `inset`, `outset`, `none` and `hidden`. `dotted`/`dashed` use native kurbo dash patterns; `double` paints two separated outline bands; the four 3D styles derive light/dark edge tones from `outlineColor`.

Interactive states are nested inside `style`, so the normal visual properties are reused instead of creating `hoverX`, `focusX` and `activeX` variants:

```tsx
<Button
  style={{
    background: theme.colors.primary,
    foreground: theme.colors.primaryForeground,
    hover: {
      background: theme.colors.primaryHover,
    },
    active: {
      background: theme.colors.primaryActive,
    },
    focus: {
      outlineWidth: 2,
      outlineColor: theme.colors.ring,
      outlineOffset: 2,
      outlineStyle: "solid",
    },
    disabled: {
      background: theme.colors.disabled,
      foreground: theme.colors.disabledForeground,
    },
  }}
>
  Save
</Button>
```

The visual cascade is `base → hover → active → focus → disabled`. States are paint-only: layout properties such as `width`, `padding` and `borderWidth` stay on the base style.

```powershell
bun run check           # TypeScript
bun run lint            # Clippy rigoroso para o backend Rust
bun run test            # TSX/protocolo, layout, dirty flags e input
bun run smoke           # janela real, GPU, FFI, cliques, edição, scroll e resize
bun run smoke:controls  # checkbox, select, textarea, switch, slider, tabs, radio e teclado
bun run smoke:virtual-list # linhas virtuais com scroll/clique e menos de 120 nós nativos
bun run verify          # checa código, janela real, tarball e EXE isolado
bun run bench           # latência em uma janela com 2.000 linhas (após build release)
bun run build           # DLL release + app/worker/assets em dist/
bun dist/basic.js
```

## Executável de produção

```powershell
bun run build:exe
.\dist\Tarve.exe

# Compila e verifica o app com um ponto de entrada de testes, sem Bun no PATH:
bun run smoke:exe
```

Distribua apenas **`dist/Tarve.exe`**. O build compila Rust em release e incorpora o runtime Bun, o app, a DLL e a imagem. O runtime C da DLL usa link estático: o destinatário não precisa instalar Bun, Node, Rust ou o redistribuível do Visual C++. O executável Windows x64 abre diretamente a janela, sem console; `renderer: "gpu"` usa D3D11/DXGI nativo por padrão e mantém Vello/WGPU como fallback, enquanto `renderer: "cpu"` usa o renderer software. Os pré-requisitos de compilação acima são necessários apenas na máquina de build.

Na inicialização, a DLL e as imagens usadas são extraídas para `%TEMP%\tarve-assets`, em diretórios identificados e verificados por SHA-256. Isso dá ao carregador do Windows e ao backend Rust caminhos físicos para os arquivos incorporados. Os caminhos ficam em cache durante a execução.

O ponto de entrada é o próprio app, `examples/basic.tsx`. O exemplo contém apenas interface, estado e execução normal. O CLI do pacote incorpora o runtime nativo automaticamente. `bun run build:exe --entry examples/basic.tsx --outfile dist/Basic.exe` é o comando de manutenção equivalente neste repositório; em um projeto consumidor, use `bun run tarve build basic.tsx --outfile dist/Basic.exe`.

Importe imagens com `import image from "./image.png" with { type: "file" }` (ou `.jpg`/`.svg`) e use `<Image src={image} />`; o core cuida da extração quando necessário. SVGs locais são rasterizados pelo backend nativo a partir do arquivo vetorial e compartilham o mesmo `Image`/`fit` de PNG/JPEG. Caminhos relativos de imagens são resolvidos em relação ao arquivo de entrada. Testes de distribuição ficam em `scripts/`, fora do executável de produção.

Para vetores de interface, prefira SVG declarativo em TSX. O Rust não conhece nomes de ícones. O core serializa a geometria para SVG e `usvg` faz parsing/normalização quando o source muda; variantes de `currentColor` são normalizadas sob demanda e mantidas em um cache pequeno por node. Geometria simples continua vetorial e o `PaintTarget` reutiliza os paths normalizados em CPU, D3D11 ou Vello; se a árvore usar recursos que exigem composição fora desse contrato (como gradients, patterns, clip/mask/filter, blend/isolation, imagem ou texto embutidos), `resvg` gera um fallback raster no tamanho físico efetivamente desenhado e mantém apenas um pequeno conjunto de variantes cacheadas, em vez de rasterizar a cada frame ou descartar silenciosamente o conteúdo:

```tsx
import { Svg, Path, Circle, Icon, type SvgNode } from "tarve";

const externalIcon: readonly SvgNode[] = [
  ["circle", { cx: 12, cy: 12, r: 9 }],
  ["path", { d: "M8 12.5 10.7 15 16 9" }],
];

<Svg size={24} viewBox="0 0 24 24">
  <Circle cx={12} cy={12} r={10} />
  <Path d="M6 12h12" />
</Svg>

<Icon iconNode={externalIcon} size={20} />
```

`Icon` mantém alguns nomes compactos por compatibilidade, mas esses nomes são resolvidos em TypeScript. `iconNode` aceita árvores SVG externas, inclusive nós aninhados. O core não conhece React, Lucide, Heroicons ou qualquer outra biblioteca. Para componentes de terceiros, registre um `ComponentAdapter`: ele recebe o tipo/props estrangeiros e, quando reconhece o componente, retorna um `VNode` Tarve.

```tsx
import { Camera as LucideCamera } from "lucide-react";
import { CameraIcon as HeroCamera } from "@heroicons/react/24/outline";
import { Camera as PhosphorCamera } from "@phosphor-icons/react";
import { IconCamera as TablerCamera } from "@tabler/icons-react";
import { lucideReactAdapter, phosphorReactAdapter, reactSvgAdapter } from "@tarve/react-icons";
import { render, Row, Window } from "tarve";

await render(() => (
  <Window>
    <Row gap={12}>
      <LucideCamera size={28} strokeWidth={1.8} />
      <HeroCamera width={28} height={28} />
      <PhosphorCamera size={28} weight="duotone" />
      <TablerCamera size={28} stroke={1.8} />
    </Row>
  </Window>
), {
  componentAdapters: [reactSvgAdapter, lucideReactAdapter, phosphorReactAdapter],
});
```

Os adapters ficam no pacote opcional `@tarve/react-icons`, separado de `packages/core`: `reactSvgAdapter` cobre componentes `forwardRef` que já retornam um `<svg>` estático (como Heroicons e Tabler), enquanto Lucide e Phosphor usam adapters pequenos para seus wrappers próprios. `@tarve/react-icons` não depende de React nem das bibliotecas de ícones; o app instala apenas as que usa. O Tarve core não tenta renderizar React nem possui branches por biblioteca. SVGs completos carregados por `<Image src={...}>` continuam usando `usvg` + `resvg`; `Svg`/`Icon` seguem o caminho vetorial normalmente e só usam o fallback `resvg` quando a árvore normalizada contém recursos que o `PaintTarget` simples não representa.

## API

```tsx
import { render, Window, Column, Text, Button } from "tarve";

let count = 0;
await render(() => (
  <Window title="Hello Tarve" width={800} height={600}>
    <Column gap={16} padding={24}>
      <Text size={24}>Count: {count}</Text>
      <Button onClick={() => count++}>Increment</Button>
    </Column>
  </Window>
));
```

Callbacks de clique/change atualizam a árvore automaticamente. Para alterações assíncronas, use `const app = createApp(App)` e `app.update()`. `id` explícito ou `key` preserva identidade ao reordenar. `style` usa pixels lógicos, números, `"auto"` ou porcentagens para tamanhos; `View style={{ display: "grid", columns: 3 }}` cria um grid. Veja `examples/basic.tsx` para todos os componentes e variantes.

## Organização

```text
packages/core/src/       componentes, JSX runtime, tema, reconciliação, app
  bridge/                bun:ffi, fila FIFO e wakeup event-driven via named pipe
packages/core/build.ts   empacotador reutilizável para apps
packages/core/cli.ts     comando tarve build
packages/react-icons/    adapters opcionais para bibliotecas React de ícones
packages/protocol/src/   contrato TypeScript versionado
native/src/              bridge C, protocolo Rust, árvore/layout/input, texto, renderer, janela
native/include/tarve.h   contrato C e ownership dos buffers
examples/basic.tsx       demonstração interativa
examples/counter.tsx     exemplo mínimo
examples/forms.tsx       controles de formulário
examples/large-list.tsx  exemplo de lista virtual
scripts/package.ts      distribuição npm com tipos e binário nativo
```

Bun envia a árvore inicial em UTF-8 JSON pela ABI C. Atualizações de propriedades enviam apenas os nós alterados; mudanças de estrutura enviam a árvore e preservam os IDs. Rust mantém os nós e caches do Taffy, preserva scroll/foco e invalida apenas os estágios necessários. A cena Vello inclui apenas as subárvores visíveis. As APIs das crates ficam internas ao backend; as fronteiras são `NativeBridge` e o protocolo versionado.

Rust usa `ControlFlow::Wait`, então a thread nativa dorme quando não há trabalho. Eventos ficam em uma fila FIFO nativa; quando ela passa de vazia para não vazia, Rust sinaliza o event loop do Bun por um named pipe do Windows. O Bun então drena a fila com `tarve_poll_event()` não bloqueante até ela ficar vazia. Não há polling periódico, Worker adicional, timer de frames ou game loop, portanto o bridge também fica sem wakeups periódicos em idle. Hover/scroll pintam; conteúdo/tipografia invalidam texto e layout; redimensionamento reutiliza o shaping e recalcula quebras/layout. Texturas de imagem e layouts de texto ficam em cache. A escala de DPI é aplicada na renderização e no hit testing.

Medições e limites do benchmark estão em `PERFORMANCE.md`. O acompanhamento do trabalho restante está em `PRODUCTION.md`.

## Escopo do bootstrap

Uma janela por processo. `Input` e `TextArea` oferecem edição Unicode e IME completo; a árvore nativa também expõe UI Automation/AccessKit no Windows. Botões aceitam Tab/Shift+Tab e Enter/Espaço; `Button` mantém o caminho nativo compacto para texto simples e também aceita composição de ícones, texto e layouts aninhados como um único controle semântico. `ScrollArea` possui clipping e scrollbars nativos vertical, horizontal ou bidirecional. Imagens locais PNG/JPEG/SVG usam `cover` ou `contain`; SVGs de UI podem ser declarados em TSX e `Icon` aceita dados vetoriais externos via `iconNode`.

`bun:ffi` é o transporte escolhido para este projeto Bun. Sua API ainda é marcada experimental pelo Bun; a ABI explícita, buffers do chamador e o named pipe usado apenas como sinal de wakeup evitam reentrância/callbacks nativos cross-thread no runtime principal. Os dados dos eventos continuam atravessando a ABI somente quando Bun drena a fila. Referências: [Bun FFI](https://bun.com/docs/runtime/ffi), [Taffy](https://docs.rs/taffy/0.14.0), [Parley](https://docs.rs/parley/0.11.1), [Vello](https://docs.rs/vello/0.10.0).
