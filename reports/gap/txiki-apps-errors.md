# Erros tolerados em `smoke:txiki-apps` (Bun também reportava)

O smoke (`scripts/smoke-txiki-apps.ts`) roda os 13 exemplos completos no Bun e como
executável txiki.js e compara o que mostram. Antes ele **tolerava** qualquer evento `error`
que o Bun também reportasse ("vem da máquina"). Regra adotada: condição de ambiente é estado
da feature, não filtro de teste; mesmo comportamento em Bun, Node e txiki.

## Levantamento (antes da correção, smoke tolerante)

| App | SO | Erro | Causa |
|---|---|---|---|
| `tray` | Linux (WSLg) | `no system tray host is running (failed to register to the StatusNotifierWatcher: org.freedesktop.DBus.Error.ServiceUnknown …); on GNOME install the AppIndicator extension` — Bun e txiki | `native/src/tray.rs`: `ksni` com `assume_sni_available(false)` falha no `spawn` sem `org.kde.StatusNotifierWatcher` no barramento; o runtime convertia em evento `error`. |
| `widget` | Linux (WSLg) | o mesmo | idem (`app.tray` no início). |
| `youtube-music` | Linux (WSLg) | o mesmo | idem (`app.tray` após `app.ready`). |
| todos os 13 | Windows | nenhum | — (Windows tem host de bandeja: Explorer). |

Nenhum outro erro "Bun também reporta" apareceu em Windows nem em Linux; as demais
diferenças do log (`onlyBun`/`onlyTx`) são dados ao vivo (FPS, CPU, memória, recomendações do
YouTube), que o smoke compara por contagem, não por igualdade.

## Correção na raiz: disponibilidade da bandeja é estado

- **Protocolo** (`packages/protocol/src/index.ts`): novo evento nativo
  `{ type: "trayAvailability", supported, available, reason? }`.
- **Nativo**:
  - Linux (`native/src/tray/linux.rs`, separado de `tray.rs`): `assume_sni_available(true)`
    sempre (sai `TARVE_TRAY_ASSUME_SNI`, também do CI). Sem watcher o item continua no
    barramento; `watcher_offline` envia `available: false` com o motivo, `watcher_online`
    envia `available: true` (o ksni observa `NameOwnerChanged` e registra o item quando um
    host aparece depois). Sem barramento de sessão: `available: false` também.
  - Windows (`tray.rs`): falha de `Shell_NotifyIconW` (taskbar ausente) vira
    `available: false`; o `TaskbarCreated` do Explorer republica e envia `available: true`.
  - Demais plataformas (Android, macOS): `supported: false` com motivo, como os device APIs.
  - Erros de verdade (ícone inválido, janela dona não criada) continuam `error`.
  - `runtime.rs`: `apply`/`publish` devolvem o evento de disponibilidade, não `Err`.
- **Core** (`packages/core/src/app/tray.ts`): `TrayAvailability`, `TrayOptions.onAvailability`
  (na primeira resposta e a cada mudança, sem repetir estado igual) e
  `TrayHandle.availability()`. Uma bandeja que substitui outra recebe o estado já conhecido.
  O despacho de `tray`/`trayMenu`/`trayAvailability` foi para o controller (`app.ts` encolheu).
- **Go** (`go/tarve`): `TrayOptions.OnAvailability`, `App.TrayAvailability()`.
- **Exemplos / template**:
  - `examples/tray` e o template `create-tarve` `tray`: sem bandeja a janela fica aberta, mostra
    "No system tray host is running on this desktop, so the window stays open and closing it
    quits.", "Hide to tray" desabilitado, fechar encerra (antes `closeBehavior: "hide"` sumia
    com a janela sem caminho de volta).
  - `examples/widget`: ✕ vira "Close widget" e fecha; se o host some com o widget escondido,
    ele volta a aparecer.
  - `examples/youtube-music`: fechar minimiza para a barra de tarefas (segue tocando) em vez
    de esconder numa bandeja inexistente.
- **Smoke estrito** (`scripts/smoke-txiki-apps.ts`): qualquer evento `error` em qualquer
  runtime falha; cabeçalho atualizado.
- **`smoke:tray`** (`scripts/smoke-tray.tsx` + `scripts/fake-sni-watcher.py`): no Linux, num
  barramento sem host, verifica `available: false` → host aparece (`true`) → host sai
  (`false`); no Windows verifica `available: true`.

## Resultados finais

| Verificação | Resultado |
|---|---|
| `smoke:txiki-apps` estrito, Linux (WSL, `work/wsl-apps/run.sh`) | ✅ 13 exemplos, `errors: [[],[]]` em todos; `tray` mostra o aviso de fallback nos dois runtimes |
| `smoke:txiki-apps` estrito, Windows | ✅ 13 exemplos, `errors: [[],[]]` em todos ("txiki.js apps: 13 examples behave as under Bun") |
| `smoke:tray` Linux (`dbus-run-session`, sem host) | ✅ `[{available:false,…}, {available:true}, {available:false,"the StatusNotifierWatcher stopped"}]` |
| `smoke:tray` Windows | ✅ `[{"supported":true,"available":true}]` |
| `cargo clippy --all-targets -D warnings` (Windows) | ✅ |
| `cargo clippy`/`check` Linux (WSL) | ✅ compila; `-D warnings` falha só em `src/protocol/requests.rs` (`Share.title`, `Location.maximum_age_ms` nunca lidos: trabalho de device de outra aba, fora deste escopo); nenhum aviso em `tray*` |
| `bun test packages/core` | ✅ 558 testes, 0 falhas (+1 teste de disponibilidade em `tray.test.ts`) |
| `bun run check` | ✅ |
| `bun run check:lines` | ✅ (`tray.rs` 646 → ~490, `app.ts` e `app.go` encolheram) |
| `go build`/`go vet`/`gofmt -l` | ✅ |
| `bun test packages/create-tarve`, `examples/youtube-music` | ✅ 22 e 10 testes |
