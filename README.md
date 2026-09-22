# Tarve

GUI nativa para **Bun + TypeScript/TSX**, com **Taffy** (Flex/Grid), **Parley** (shaping, medição e quebra de texto) e **Vello/WGPU** (GPU). Janela Win32 via Winit. O tema padrão usa a linguagem visual shadcn: zinc, superfícies claras, bordas discretas, raios de 6–12 px e Segoe UI.

## Rodar no Windows

Pré-requisitos: Bun 1.4+, Rust estável com target `x86_64-pc-windows-msvc`, Visual Studio Build Tools com C++/Windows SDK e GPU com suporte a compute shaders (DirectX 12 ou Vulkan).

```powershell
cd A:\tarve
bun install
bun run dev
```

`dev` compila a DLL e inicia o exemplo com reinício ao editar TS/TSX. Após editar Rust, compile novamente e reinicie o app. Cada build de desenvolvimento tem um nome de DLL próprio, permitindo compilar enquanto a janela anterior ainda está aberta. Para abrir sem recompilar: `bun run start`.

## Usar como pacote npm

O pacote para Windows x64 inclui a DLL em release; quem instala precisa somente do Bun e de um driver de GPU compatível. A publicação no registry ainda é uma etapa separada. Para gerar e instalar o artefato local:

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

`examples/counter.tsx` mostra o app mínimo e `examples/basic.tsx` reúne os componentes iniciais. Exemplos usam a mesma API instalada, sem configurar a DLL ou o Worker.

`examples/` também funciona como uma pasta executável independente durante o desenvolvimento:

```powershell
cd A:\tarve\examples
bun run counter.tsx
bun run basic.tsx

# Builds standalone de produção a partir da própria pasta de exemplos:
bun run build:counter
bun run build:basic
```

Os executáveis são gerados em `examples/dist/`. O `tsconfig.json` local apenas herda a configuração do projeto; os arquivos `.tsx` continuam sendo exemplos normais que importam a API pública `tarve`.

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
  <TextInput placeholder="Project name" />
</Modal>
```

### Custom title bar

`TitleBar` is declarative: simply render it inside `Window`. Tarve resolves the component tree before creating the native window, detects the title bar, and automatically selects custom window chrome. Without `TitleBar`, the operating-system title bar remains native. On Windows 11 Tarve asks DWM to keep the native rounded window corners and compositor border while the title bar remains fully custom. The root also draws a 1 px shadcn/zinc border with an 8 px radius as a visual fallback. Native drag, minimize/maximize/close and the 6 px resize hit area remain available.

```tsx
<Window title="My app" width={1000} height={700}>
  <TitleBar title="My app" />
  <View flex={1}>{/* app */}</View>
</Window>
```

`TitleBar` accepts normal `style` overrides and custom `children`, plus `showMinimize`, `showMaximize`, `showClose` and `height`. Double-clicking its draggable area toggles maximize/restore.

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
bun run test            # TSX/protocolo, layout, dirty flags e input
bun run smoke           # janela real, GPU, FFI, cliques, edição, scroll e resize
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

Distribua apenas **`dist/Tarve.exe`**. O build compila Rust em release e incorpora o runtime Bun, o app, o Worker de eventos, a DLL e a imagem. O runtime C da DLL usa link estático: o destinatário não precisa instalar Bun, Node, Rust ou o redistribuível do Visual C++. O executável Windows x64 abre diretamente a janela, sem console; continua precisando de GPU/driver compatível com Vello/WGPU. Os pré-requisitos de compilação acima são necessários apenas na máquina de build.

Na inicialização, a DLL, o Worker e as imagens usadas são extraídos para `%TEMP%\tarve-assets`, em diretórios identificados e verificados por SHA-256. Isso dá ao carregador do Windows e ao backend Rust caminhos físicos para os arquivos incorporados. Os caminhos ficam em cache durante a execução.

O ponto de entrada é o próprio app, `examples/basic.tsx`. O exemplo contém apenas interface, estado e execução normal. O comando de build incorpora o runtime nativo automaticamente. Para compilar outro app: `bun run build:exe --entry examples/meu-app.tsx --outfile dist/MeuApp.exe`. A versão vem de `package.json`.

Importe imagens com `import image from "./image.png" with { type: "file" }` e use `<Image src={image} />`; o core cuida da extração quando necessário. Caminhos relativos de imagens são resolvidos em relação ao arquivo de entrada. Testes de distribuição ficam em `scripts/`, fora do executável de produção.

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
  bridge/                bun:ffi e Worker bloqueante de eventos
packages/core/build.ts   empacotador reutilizável para apps
packages/core/cli.ts     comando tarve build
packages/protocol/src/   contrato TypeScript versionado
native/src/              bridge C, protocolo Rust, árvore/layout/input, texto, renderer, janela
native/include/tarve.h   contrato C e ownership dos buffers
examples/basic.tsx       demonstração interativa
examples/counter.tsx     exemplo mínimo
scripts/package.ts      distribuição npm com tipos e binário nativo
```

Bun envia a árvore inicial em UTF-8 JSON pela ABI C. Atualizações de propriedades enviam apenas os nós alterados; mudanças de estrutura enviam a árvore e preservam os IDs. Rust mantém os nós e caches do Taffy, preserva scroll/foco e invalida apenas os estágios necessários. A cena Vello inclui apenas as subárvores visíveis. As APIs das crates ficam internas ao backend; as fronteiras são `NativeBridge` e o protocolo versionado.

Rust usa `ControlFlow::Wait`. Um Worker Bun espera numa condition variable e entrega eventos à thread do app; não há polling, timer de frames ou game loop. Hover/scroll pintam; conteúdo/tipografia invalidam texto e layout; redimensionamento reutiliza o shaping e recalcula quebras/layout. Texturas de imagem e layouts de texto ficam em cache. A escala de DPI é aplicada na renderização e no hit testing.

Medições e limites do benchmark estão em `PERFORMANCE.md`. O acompanhamento do trabalho restante está em `PRODUCTION.md`.

## Escopo do bootstrap

Uma janela por processo. `TextInput` oferece foco, entrada Unicode, backspace/delete por grapheme, setas, Home/End, Ctrl+A, copiar/colar/recortar e commit de IME; seleção por mouse, undo, preedit visual, edição bidi avançada e acessibilidade via AccessKit ficam para a próxima etapa. Botões aceitam Tab/Shift+Tab e Enter/Espaço. Scroll vertical tem clipping e indicador. Imagens locais PNG/JPEG usam `cover` ou `contain`. `Text` e `Button` recebem texto simples; composição rica pode ser adicionada ao protocolo.

`bun:ffi` é o transporte escolhido para este projeto Bun. Sua API ainda é marcada experimental pelo Bun; a ABI explícita, buffers do chamador e Worker sem callbacks nativos reduzem a superfície de integração. Referências: [Bun FFI](https://bun.com/docs/runtime/ffi), [Taffy](https://docs.rs/taffy/0.14.0), [Parley](https://docs.rs/parley/0.11.1), [Vello](https://docs.rs/vello/0.10.0).
